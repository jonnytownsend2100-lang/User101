/**
 * A small, dependency-free HTML parser, good enough to audit real pages.
 *
 * It is a real tokenizer rather than a pile of regexes, because regex HTML
 * parsing silently mis-reads the exact things an audit depends on: attributes
 * containing `>`, raw-text elements whose contents are not markup
 * (`<script>if (a < b) …`), and comments. The tokenizer handles all three.
 *
 * It is deliberately not a spec-compliant tree builder: we extract the
 * document *signals* an audit needs (head metadata, landmarks, headings,
 * images, anchors, forms, text) without pretending to normalise the DOM.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', middot: '\u00b7', bull: '\u2022',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Read one tag starting at `i` (which points at '<'). Returns null if malformed. */
function readTag(html, i) {
  let j = i + 1;
  let isClosing = false;
  if (html[j] === '/') { isClosing = true; j++; }
  const nameStart = j;
  while (j < html.length && /[^\s/>]/.test(html[j])) j++;
  const name = html.slice(nameStart, j).toLowerCase();
  if (!name) return null;

  const attrs = Object.create(null);
  let selfClosing = false;

  while (j < html.length) {
    while (j < html.length && /\s/.test(html[j])) j++;
    if (j >= html.length) break;
    if (html[j] === '>') { j++; break; }
    if (html[j] === '/' && html[j + 1] === '>') { selfClosing = true; j += 2; break; }
    if (html[j] === '/') { j++; continue; }

    const attrStart = j;
    while (j < html.length && /[^\s=>/]/.test(html[j])) j++;
    if (j === attrStart) { j++; continue; }        // stray char, skip it
    const attrName = html.slice(attrStart, j).toLowerCase();
    while (j < html.length && /\s/.test(html[j])) j++;

    let value = '';
    if (html[j] === '=') {
      j++;
      while (j < html.length && /\s/.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, j + 1);
        const stop = end === -1 ? html.length : end;
        value = html.slice(j + 1, stop);
        j = stop + 1;
      } else {
        const valStart = j;
        while (j < html.length && /[^\s>]/.test(html[j])) j++;
        value = html.slice(valStart, j);
      }
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value).trim();
  }

  return { name, attrs, isClosing, selfClosing, end: j };
}

/** Split HTML into text / tag / comment / declaration / raw-text tokens. */
export function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { tokens.push({ type: 'text', text: html.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', text: html.slice(i, lt) });

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      tokens.push({ type: 'comment', text: html.slice(lt + 4, end === -1 ? n : end) });
      i = stop; continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? n : end + 1;
      tokens.push({ type: 'decl', text: html.slice(lt, stop) });
      i = stop; continue;
    }

    const tag = readTag(html, lt);
    if (!tag) { tokens.push({ type: 'text', text: html.slice(lt) }); break; }
    tokens.push({ type: 'tag', ...tag });
    i = tag.end;

    if (tag.isClosing || tag.selfClosing || VOID.has(tag.name)) continue;
    if (RAW_TEXT.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'i');
      const m = close.exec(html.slice(i));
      const contentEnd = m ? i + m.index : n;
      tokens.push({ type: 'rawtext', name: tag.name, text: html.slice(i, contentEnd) });
      i = m ? i + m.index + m[0].length : n;
    }
  }
  return tokens;
}

/** Extract the audit-relevant document model from HTML. */
export function parseHtml(html) {
  const tokens = tokenize(html);
  const doc = {
    raw: html,
    doctype: false,
    lang: '',
    charsetMeta: '',
    title: '',
    metaDescription: '',
    metaRobots: '',
    metaViewport: '',
    metas: [],
    links: [],
    scripts: [],
    styles: [],
    headings: [],
    images: [],
    anchors: [],
    inputs: [],
    labels: [],
    buttons: [],
    landmarks: { main: 0, article: 0, section: 0, header: 0, nav: 0, footer: 0, aside: 0, figure: 0 },
    noscript: 0,
    jsonLd: [],
    jsonLdErrors: 0,
    textParts: [],
    inlineScriptBytes: 0,
    inlineStyleBytes: 0,
    iframes: [],
    hasSkipLink: false,
  };

  const captureStack = [];
  const CAPTURE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'label']);

  const emit = (entry) => {
    const text = decodeEntities(entry.buf).replace(/\s+/g, ' ').trim();
    switch (entry.name) {
      case 'title': doc.title = text; break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (text) doc.headings.push({ level: Number(entry.name[1]), text });
        break;
      case 'a': doc.anchors.push({ ...entry.attrs, text }); break;
      case 'button': doc.buttons.push({ ...entry.attrs, text }); break;
      case 'label': doc.labels.push({ ...entry.attrs, text }); break;
      default: break;
    }
  };

  for (const t of tokens) {
    if (t.type === 'decl') {
      if (/^<!doctype/i.test(t.text)) doc.doctype = true;
      continue;
    }
    if (t.type === 'comment') continue;

    if (t.type === 'text') {
      // Raw-text element bodies never reach here: the tokenizer emits them as
      // `rawtext` tokens, so every `text` token is genuinely visible text.
      doc.textParts.push(t.text);
      for (const e of captureStack) e.buf += t.text;
      continue;
    }

    if (t.type === 'rawtext') {
      const bytes = Buffer.byteLength(t.text);
      if (t.name === 'script') {
        doc.inlineScriptBytes += bytes;
        const entry = doc._pendingScript;
        if (entry) { entry.content = t.text; entry.inlineBytes = bytes; doc._pendingScript = null; }
        else doc.scripts.push({ src: '', type: '', async: false, defer: false, module: false, inlineBytes: bytes, content: t.text });
      } else if (t.name === 'style') {
        doc.inlineStyleBytes += bytes;
        const entry = doc._pendingStyle;
        if (entry) { entry.content = t.text; entry.inlineBytes = bytes; doc._pendingStyle = null; }
        else doc.styles.push({ href: '', media: '', inlineBytes: bytes, content: t.text });
      } else if (t.name === 'title') {
        doc.title = decodeEntities(t.text).replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    // t.type === 'tag'
    if (t.isClosing) {
      for (let k = captureStack.length - 1; k >= 0; k--) {
        if (captureStack[k].name === t.name) {
          const [entry] = captureStack.splice(k, 1);
          emit(entry);
          break;
        }
      }
      continue;
    }

    applyStartTag(doc, t);

    if (CAPTURE.has(t.name) && !t.selfClosing && !VOID.has(t.name)) {
      captureStack.push({ name: t.name, attrs: { ...t.attrs }, buf: '' });
    }
  }

  // A skip link is an early in-page anchor whose text mentions skipping.
  doc.hasSkipLink = doc.anchors.some((x) => /^#/.test(x.href || '') && /skip/i.test(x.text || ''));

  // JSON-LD blocks live inside <script type="application/ld+json">.
  for (const s of doc.scripts) {
    if (s.type === 'application/ld+json' && s.content) {
      try { doc.jsonLd.push(JSON.parse(s.content)); } catch { doc.jsonLdErrors++; }
    }
  }

  doc.text = normalizeText(doc.textParts.join(' '));
  return doc;
}

/** Handle a start tag, mutating the document model in place. */
function applyStartTag(doc, t) {
  const a = t.attrs;
  switch (t.name) {
    case 'html':
      if (a.lang) doc.lang = a.lang;
      break;
    case 'meta': {
      if (a.charset) doc.charsetMeta = a.charset;
      const name = (a.name || '').toLowerCase();
      const property = (a.property || '').toLowerCase();
      const content = a.content || '';
      doc.metas.push({ name, property, content, httpEquiv: (a['http-equiv'] || '').toLowerCase() });
      if (name === 'description') doc.metaDescription = content;
      if (name === 'robots') doc.metaRobots = content;
      if (name === 'viewport') doc.metaViewport = content;
      break;
    }
    case 'link':
      doc.links.push({ rel: (a.rel || '').toLowerCase(), href: a.href || '', hreflang: a.hreflang, as: a.as, media: a.media });
      break;
    case 'script': {
      const type = (a.type || '').toLowerCase();
      const entry = { src: a.src || '', type, async: 'async' in a, defer: 'defer' in a, module: type === 'module', inlineBytes: 0, content: '' };
      doc.scripts.push(entry);
      // A non-self-closing <script> is followed by a `rawtext` token with its body.
      if (!t.selfClosing) doc._pendingScript = entry;
      break;
    }
    case 'style': {
      const entry = { href: '', media: a.media || '', inlineBytes: 0, content: '' };
      doc.styles.push(entry);
      if (!t.selfClosing) doc._pendingStyle = entry;
      break;
    }
    case 'img':
      doc.images.push({ src: a.src || a['data-src'] || '', alt: a.alt, loading: (a.loading || '').toLowerCase(), width: a.width || '', height: a.height || '', srcset: a.srcset || '' });
      break;
    case 'input':
      doc.inputs.push({ tag: 'input', kind: (a.type || 'text').toLowerCase(), id: a.id, name: a.name, ariaLabel: a['aria-label'] || '', placeholder: a.placeholder || '', type: a.type });
      break;
    case 'select':
      doc.inputs.push({ tag: 'select', kind: 'select', id: a.id, name: a.name, ariaLabel: a['aria-label'] || '', placeholder: '' });
      break;
    case 'textarea':
      doc.inputs.push({ tag: 'textarea', kind: 'textarea', id: a.id, name: a.name, ariaLabel: a['aria-label'] || '', placeholder: a.placeholder || '' });
      break;
    case 'iframe':
      doc.iframes.push({ src: a.src || '', title: a.title || '', loading: (a.loading || '').toLowerCase() });
      break;
    case 'main': doc.landmarks.main++; break;
    case 'article': doc.landmarks.article++; break;
    case 'section': doc.landmarks.section++; break;
    case 'header': doc.landmarks.header++; break;
    case 'nav': doc.landmarks.nav++; break;
    case 'footer': doc.landmarks.footer++; break;
    case 'aside': doc.landmarks.aside++; break;
    case 'figure': doc.landmarks.figure++; break;
    case 'noscript': doc.noscript++; break;
    default: break;
  }
}

export function normalizeText(s) {
  return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
}

/** Meta lookup helpers. */
export function metaByName(doc, name) {
  const key = name.toLowerCase();
  return doc.metas.find((m) => m.name === key)?.content || '';
}

export function metaByProperty(doc, prop) {
  const key = prop.toLowerCase();
  return doc.metas.find((m) => m.property === key)?.content || '';
}

/** Flatten every JSON-LD `@type` found in the document. */
export function schemaTypes(doc) {
  const out = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) t.forEach((x) => { if (typeof x === 'string') out.add(x); });
    if (node['@graph']) walk(node['@graph']);
    for (const [k, v] of Object.entries(node)) {
      if (k === '@type') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  doc.jsonLd.forEach(walk);
  return [...out];
}

/** Ordered heading outline, for structure checks. */
export function headingOutline(doc) {
  return doc.headings.map((h) => ({ level: h.level, text: h.text }));
}

/** Count words in the extracted visible text. */
export function wordCount(text) {
  const m = String(text || '').match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}


