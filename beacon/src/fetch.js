/**
 * Safe HTTP fetch for auditing arbitrary, user-supplied URLs.
 *
 * Auditing means fetching URLs we do not control, which makes SSRF the primary
 * risk: a "customer" submits `http://169.254.169.254/latest/meta-data/` and the
 * server dutifully fetches cloud credentials. So every hop is validated:
 *   - scheme allow-list (http/https only)
 *   - hostname resolved, and every resolved address checked against private,
 *     loopback, link-local, CGNAT and reserved ranges
 *   - redirects followed manually, re-validating at each hop
 *   - hard byte cap enforced *during* the read, not after
 *   - wall-clock deadline via AbortController
 *
 * Zero dependencies: node:net, node:dns, global fetch (undici).
 */

import net from 'node:net';
import dns from 'node:dns/promises';

export const DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
  userAgent: 'BeaconAudit/0.1 (+https://github.com/beacon-audit; audit bot)',
};

export class FetchError extends Error {
  constructor(message, code = 'EFETCH') {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

/** True when an IPv4/IPv6 literal points somewhere we must never fetch. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;                // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;       // private
    if (a === 192 && b === 168) return true;                // private
    if (a === 192 && b === 0) return true;                  // 192.0.0/24 + test nets
    if (a === 198 && (b === 18 || b === 19)) return true;   // benchmarking
    if (a >= 224) return true;                              // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().split('%')[0];
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true; // link-local, ULA
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);      // IPv4-mapped
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // not an IP -> caller should have resolved it first
}

/** Parse + validate a target URL. Throws FetchError on anything disallowed. */
export function parseTarget(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new FetchError(`not a valid URL: ${raw}`, 'EBADURL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`scheme not allowed: ${url.protocol}`, 'ESCHEME');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) {
    throw new FetchError(`host not allowed: ${host}`, 'EHOST');
  }
  return url;
}

/** Resolve a hostname and assert no resolved address is private. */
export async function assertResolvableAndPublic(host, { lookup = dns.lookup } = {}) {
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchError(`address not allowed: ${host}`, 'EADDR');
    return [host];
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    throw new FetchError(`DNS lookup failed for ${host}: ${e.code || e.message}`, 'EDNS');
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a.address));
  if (!list.length) throw new FetchError(`no addresses for ${host}`, 'EDNS');
  for (const a of list) {
    if (isPrivateAddress(a)) throw new FetchError(`resolves to non-public address: ${a}`, 'EADDR');
  }
  return list;
}

/** Read a Response body with a hard byte ceiling. */
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new FetchError(`body exceeds ${maxBytes} bytes`, 'ETOOLARGE');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new FetchError(`body exceeds ${maxBytes} bytes`, 'ETOOLARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL, following redirects with per-hop SSRF validation.
 * @returns {Promise<{finalUrl,status,ok,headers,body,bytes,timingMs,redirects,contentType}>}
 */
export async function fetchUrl(rawUrl, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const started = Date.now();
  const redirects = [];
  let url = parseTarget(rawUrl);

  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    await assertResolvableAndPublic(url.hostname.replace(/^\[|\]$/g, ''), o);

    const ac = new AbortController();
    const remaining = o.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new FetchError('deadline exceeded', 'ETIMEOUT');
    const timer = setTimeout(() => ac.abort(), remaining);

    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'user-agent': o.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en',
        },
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new FetchError(`timed out after ${o.timeoutMs}ms`, 'ETIMEOUT');
      throw new FetchError(`network error: ${e.cause?.code || e.message}`, 'ENET');
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      redirects.push(next.toString());
      url = parseTarget(next.toString());
      try { await res.arrayBuffer(); } catch { /* drain to reuse socket */ }
      continue;
    }

    const headers = Object.fromEntries(res.headers.entries());
    const contentType = headers['content-type'] || '';
    const body = await readCapped(res, o.maxBytes);
    const charset = (contentType.match(/charset=([^;]+)/i)?.[1] || 'utf-8').trim().toLowerCase();
    let text = body.toString('utf8');
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      try { text = new TextDecoder(charset).decode(body); } catch { /* keep utf8 */ }
    }

    return {
      finalUrl: url.toString(),
      status: res.status,
      ok: res.ok,
      headers,
      body: text,
      bytes: body.byteLength,
      timingMs: Date.now() - started,
      redirects,
      contentType,
    };
  }
  throw new FetchError(`too many redirects (>${o.maxRedirects})`, 'EREDIRECT');
}

/** Small helper for auxiliary files (robots.txt, sitemap.xml, llms.txt). */
export async function fetchAux(url, opts = {}) {
  try {
    const r = await fetchUrl(url, { maxBytes: 512 * 1024, timeoutMs: 8000, ...opts });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}
