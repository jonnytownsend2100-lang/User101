/**
 * Swarm Console client.
 *
 * Rendering is a small keyed reconcile (task rows are reused by taskId) so
 * updates stream in smoothly instead of rebuilding the table on every frame.
 * All data comes from GET /api/state plus the SSE stream at /api/stream.
 */

const $ = (sel) => document.querySelector(sel);

const ui = {
  stats: $('#stats'),
  rows: $('#task-rows'),
  empty: $('#empty-board'),
  filters: $('#filters'),
  form: $('#submit-form'),
  title: $('#f-title'),
  kind: $('#f-kind'),
  payload: $('#f-payload'),
  presets: $('#presets'),
  formError: $('#form-error'),
  nodeList: $('#node-list'),
  poolSummary: $('#pool-summary'),
  log: $('#log'),
  logToggle: $('#log-toggle'),
  conn: $('#connection'),
  connText: $('#connection-text'),
  nodesCount: $('#nodes-count'),
  footConfig: $('#foot-config'),
};

const MAX_LOG = 300;
const rowCache = new Map();
const seenEvents = new Set();

let snapshot = null;
let filter = 'all';
let logPaused = false;
let configReady = false;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FILTERS = {
  all: () => true,
  active: (t) => t.state === 'pending' || t.state === 'claimed' || t.state === 'failed',
  done: (t) => t.state === 'done',
  failed: (t) => t.state === 'failed' || t.state === 'dead',
};

// ---- boot ----------------------------------------------------------------
async function boot() {
  wireInteractions();
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyState(await res.json());
  } catch (err) {
    setConnection('down', `offline (${err.message})`);
  }
  openStream();
}

function openStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConnection('live', 'live'));
  es.addEventListener('error', () => setConnection('down', 'reconnecting'));

  es.addEventListener('state', (event) => {
    setConnection('live', 'live');
    try { applyState(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
  });

  es.addEventListener('log', (event) => {
    try { appendEvent(JSON.parse(event.data)); } catch { /* ignore */ }
  });
}

function setConnection(kind, text) {
  ui.conn.className = `conn conn--${kind}`;
  ui.connText.textContent = text;
}

function applyState(state) {
  snapshot = state;

  if (!configReady) {
    configReady = true;
    renderConfig(state.config);
  }

  renderStats(state.stats);
  renderTasks(state.tasks);
  renderNodes(state.nodes, state.pool);
  ui.nodesCount.textContent = state.pool.running;

  if (Array.isArray(state.events)) {
    for (const event of state.events) appendEvent(event);
  }
}

// ---- config-driven chrome ------------------------------------------------
function renderConfig(config) {
  ui.kind.innerHTML = config.handlers.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  ui.kind.value = 'primes';

  ui.presets.innerHTML = config.presets
    .map((p, i) => `<button class="preset" type="button" data-preset="${i}">${esc(p.title)}</button>`)
    .join('');

  ui.presets.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-preset]');
    if (!btn) return;
    const preset = config.presets[Number(btn.dataset.preset)];
    ui.title.value = preset.title;
    ui.kind.value = preset.kind;
    ui.payload.value = JSON.stringify(preset.payload ?? {}, null, 2);
    ui.title.focus();
  });

  ui.footConfig.textContent =
    `store=${config.store} · registry=${config.registry} · lease=${config.leaseMs}ms · max ${config.maxNodes} nodes — ${config.note}`;
}

// ---- stats ---------------------------------------------------------------
function renderStats(stats) {
  const cards = [
    { key: 'queued', label: 'Queued', value: stats.queued, sub: 'awaiting a claim' },
    { key: 'inflight', label: 'In flight', value: stats.inFlight, sub: 'leased to a node' },
    { key: 'done', label: 'Done', value: stats.done, sub: stats.successRate == null ? '—' : `${Math.round(stats.successRate * 100)}% success` },
    { key: 'failed', label: 'Retrying', value: stats.retrying, sub: 'backoff pending' },
    { key: 'dead', label: 'Dead', value: stats.dead, sub: 'dead-lettered' },
    { key: 'attempts', label: 'Attempts', value: stats.attempts, sub: `${stats.retries} retr${stats.retries === 1 ? 'y' : 'ies'}` },
  ];
  ui.stats.innerHTML = cards
    .map((c) => `
      <div class="stat stat--${c.key}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${esc(c.sub)}</div>
      </div>`)
    .join('');
}

// ---- task board ----------------------------------------------------------
function renderTasks(tasks) {
  const visible = tasks.filter(FILTERS[filter]);
  ui.empty.hidden = visible.length > 0;

  const present = new Set();
  let previous = null;

  for (const task of visible) {
    present.add(task.taskId);
    let row = rowCache.get(task.taskId);

    if (!row) {
      row = document.createElement('tr');
      row.dataset.taskId = task.taskId;
      row.innerHTML = '<td class="col-state"></td><td class="col-kind"></td><td class="col-title"></td>'
        + '<td class="col-node"></td><td class="col-attempts"></td><td class="col-result"></td><td class="col-actions"></td>';
      row.classList.add('is-new');
      setTimeout(() => row.classList.remove('is-new'), 1200);
      rowCache.set(task.taskId, row);
    }

    updateRow(row, task);

    // Keep DOM order in sync without rebuilding the tbody.
    const wanted = previous ? previous.nextSibling : ui.rows.firstChild;
    if (row !== wanted) ui.rows.insertBefore(row, wanted);
    previous = row;
  }

  for (const [taskId, row] of rowCache) {
    if (!present.has(taskId)) {
      row.remove();
      rowCache.delete(taskId);
    }
  }
}

function updateRow(row, task) {
  const cells = row.children;
  cells[0].innerHTML = `<span class="pill pill--${esc(task.state)}">${esc(task.state)}</span>`;
  cells[1].innerHTML = `<span class="mono">${esc(task.kind)}</span>`;
  cells[2].innerHTML = `<div class="task-title">${esc(task.title)}</div><div class="task-id">${esc(task.taskId)}</div>`;
  cells[3].innerHTML = task.nodeId ? `<span class="mono">${esc(task.nodeId)}</span>` : '<span class="muted">—</span>';
  cells[4].innerHTML = `<span class="mono">${esc(task.attempts)}</span>`;
  cells[5].innerHTML = resultCell(task);
  cells[6].innerHTML = task.state === 'dead' || task.state === 'failed'
    ? `<button class="requeue" type="button" data-requeue="${esc(task.taskId)}">requeue</button>`
    : '';
}

function resultCell(task) {
  if (task.state === 'claimed') return '<span class="mono">running…</span>';
  if (task.error) return `<span class="result result--error" title="${esc(task.error)}">${esc(task.error)}</span>`;
  if (task.result) {
    const json = JSON.stringify(task.result);
    return `<span class="result" title="${esc(json)}">${esc(json)}</span>`;
  }
  return '<span class="muted">—</span>';
}

// ---- nodes ---------------------------------------------------------------
function renderNodes(nodes, pool) {
  ui.poolSummary.textContent = `${pool.running} running`;

  if (!nodes.length) {
    ui.nodeList.innerHTML = '<li class="node"><span class="node-dot"></span><span class="node-name">no nodes</span><span class="node-meta">scale up to start</span></li>';
    return;
  }

  ui.nodeList.innerHTML = nodes.map((node) => {
    const running = node.status === 'running';
    const meta = running || node.status === 'stopping'
      ? `${node.processed} done${node.failed ? ` · ${node.failed} failed` : ''}`
      : node.alive ? 'idle' : 'offline';
    const stop = running ? `<button class="node-stop" type="button" data-stop="${esc(node.nodeId)}">stop</button>` : '';
    return `<li class="node node--${esc(node.status)}">
      <span class="node-dot"></span>
      <span><span class="node-name">${esc(node.nodeId)}</span><br><span class="node-meta">${esc(meta)}</span></span>
      ${stop}
    </li>`;
  }).join('');
}

// ---- activity log --------------------------------------------------------
function describe(event) {
  switch (event.type) {
    case 'task-submitted': return ['submitted', `submitted ${event.kind} ${event.taskId}`];
    case 'task-requeued': return ['submitted', `requeued ${event.taskId}`];
    case 'requeue-missed': return ['error', `requeue missed ${event.taskId}`];
    case 'node-tick': return ['acked', `${event.nodeId} +${event.acked} ok${event.failed ? ` · ${event.failed} failed` : ''}`];
    case 'node-stopped': return ['', `${event.nodeId} stopped after ${event.processed} task(s)`];
    case 'node-error': return ['error', `${event.nodeId} error: ${event.error}`];
    case 'pool-scaled': return ['', `pool scaled to ${event.running} node(s)`];
    case 'demo-seeded': return ['submitted', `seeded ${event.count} demo tasks`];
    case 'burst-enqueued': return ['submitted', `enqueued ${event.count} tasks`];
    default: return ['', String(event.type)];
  }
}

function appendEvent(event) {
  if (logPaused || seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  if (seenEvents.size > 4000) seenEvents.clear();

  const [cls, text] = describe(event);
  const li = document.createElement('li');
  li.innerHTML = `<span class="log-time">${new Date(event.at).toLocaleTimeString([], { hour12: false })}</span>`
    + `<span class="log-kind log-kind--${esc(cls)}">${esc(text)}</span>`;
  ui.log.appendChild(li);

  while (ui.log.children.length > MAX_LOG) ui.log.removeChild(ui.log.firstChild);
  ui.log.scrollTop = ui.log.scrollHeight;
}



// ---- interactions --------------------------------------------------------
function wireInteractions() {
  ui.filters.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    filter = tab.dataset.filter;
    for (const other of ui.filters.querySelectorAll('.tab')) other.classList.toggle('is-active', other === tab);
    if (snapshot) renderTasks(snapshot.tasks);
  });

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.formError.hidden = true;

    let payload = null;
    const raw = ui.payload.value.trim();
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch { return showFormError('Payload must be valid JSON.'); }
    }

    try {
      await api('/api/tasks', { title: ui.title.value, kind: ui.kind.value, payload });
      ui.title.value = '';
    } catch (err) {
      showFormError(err.message);
    }
  });

  ui.rows.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-requeue]');
    if (!button) return;
    button.disabled = true;
    try { await api(`/api/tasks/${encodeURIComponent(button.dataset.requeue)}/requeue`, {}); }
    catch { button.disabled = false; }
  });

  ui.nodeList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-stop]');
    if (!button) return;
    button.disabled = true;
    try { await api(`/api/nodes/${encodeURIComponent(button.dataset.stop)}/stop`, {}); }
    catch { button.disabled = false; }
  });

  const runningCount = () => snapshot?.pool?.running ?? 0;
  $('#nodes-up').addEventListener('click', () => scale(runningCount() + 1));
  $('#nodes-down').addEventListener('click', () => scale(runningCount() - 1));

  $('#seed').addEventListener('click', (event) => withBusy(event.currentTarget, () => api('/api/demo', {})));
  $('#burst').addEventListener('click', (event) => withBusy(event.currentTarget, () => api('/api/burst', { count: 25 })));

  ui.logToggle.addEventListener('click', () => {
    logPaused = !logPaused;
    ui.logToggle.textContent = logPaused ? 'resume' : 'pause';
  });
}

async function scale(count) {
  try { await api('/api/nodes', { count }); } catch { /* the stream will show the truth */ }
}

async function withBusy(button, fn) {
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; }
}

function showFormError(message) {
  ui.formError.textContent = message;
  ui.formError.hidden = false;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

boot();
