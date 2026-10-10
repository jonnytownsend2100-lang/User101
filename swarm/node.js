#!/usr/bin/env node
/**
 * Swarm node — durable worker whose identity and state live in git.
 *
 * Key idea: an atomic `git push` to refs/heads/swarm/claims/<taskId> is a
 * distributed lock. Git allows exactly one winner; losers get a rejection.
 *
 * Usage:
 *   node swarm/node.js init
 *   node swarm/node.js submit "description"
 *   node swarm/node.js run [--once]
 *   node swarm/node.js status
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SWARM = path.join(ROOT, 'swarm');
const DIRS = {
  nodes: path.join(ROOT, 'nodes'),
  inbox: path.join(SWARM, 'inbox'),
  claims: path.join(SWARM, 'claims'),
  outbox: path.join(SWARM, 'outbox'),
  heartbeat: path.join(SWARM, 'heartbeat'),
};

const NODE_ID = process.env.SWARM_NODE_ID || defaultNodeId();
const POLL_MS = Number(process.env.SWARM_POLL_MS || 5000);
const HEARTBEAT_MS = Number(process.env.SWARM_HEARTBEAT_MS || 15000);
const STALE_MS = Number(process.env.SWARM_STALE_MS || 60000);

// ---------- helpers ----------

const log = (...a) => console.log(new Date().toISOString(), '[node]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultNodeId() {
  const host = (process.env.HOSTNAME || 'sandbox').replace(/[^a-z0-9]/gi, '-').slice(0, 12);
  const salt = process.env.SWARM_SALT || 'local';
  const h = crypto.createHash('sha256').update(`${host}:${salt}`).digest('hex').slice(0, 6);
  return `node-${h}`;
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32); }

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args) {
  try { return { ok: true, out: git(args) }; }
  catch (e) { return { ok: false, out: (e.stderr || e.message || '').toString().trim() }; }
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function ensureDirs() {
  Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function syncFromOrigin() {
  const pull = tryGit(['pull', '--rebase', '--autostash', 'origin', 'cline/xe92gsgj']);
  if (!pull.ok) log('pull skipped:', pull.out.split('\n')[0]);
}

function commitAndPush(message) {
  tryGit(['add', '-A']);
  const c = tryGit(['commit', '-m', message]);
  if (!c.ok && /nothing to commit/.test(c.out)) return { ok: true, noop: true };
  const push = tryGit(['push', 'origin', 'HEAD:cline/xe92gsgj']);
  if (!push.ok) log('push failed:', push.out.split('\n')[0]);
  return push;
}

// ---------- identity ----------

function identityPath() { return path.join(DIRS.nodes, `${NODE_ID}.json`); }
function statePath() { return path.join(DIRS.nodes, `${NODE_ID}.state.json`); }

function init() {
  ensureDirs();
  // Private key is generated ONLY if injected; it is never persisted to git.
  const injected = process.env.SWARM_NODE_KEY;
  const descriptor = {
    nodeId: NODE_ID,
    publicKey: injected ? `ed25519:${sha(injected)}` : `ephemeral:${sha(String(Date.now()))}`,
    keyInjected: Boolean(injected),
    capabilities: ['code-edit', 'test-run', `node-${process.versions.node}`],
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  writeJSON(identityPath(), descriptor);
  if (!fs.existsSync(statePath())) {
    writeJSON(statePath(), { nodeId: NODE_ID, processed: [], lastTaskId: null, startedAt: new Date().toISOString() });
  }
  log(`identity written for ${NODE_ID} (keyInjected=${descriptor.keyInjected})`);
  commitAndPush(`node(${NODE_ID}): init identity`);
}

// ---------- heartbeat ----------

function heartbeat() {
  writeJSON(path.join(DIRS.heartbeat, `${NODE_ID}.json`), {
    nodeId: NODE_ID, seenAt: new Date().toISOString(), pid: process.pid,
  });
  commitAndPush(`node(${NODE_ID}): heartbeat`);
}

function peers() {
  if (!fs.existsSync(DIRS.heartbeat)) return [];
  const now = Date.now();
  return fs.readdirSync(DIRS.heartbeat).map((f) => {
    const h = readJSON(path.join(DIRS.heartbeat, f)) || {};
    const age = h.seenAt ? now - Date.parse(h.seenAt) : Infinity;
    return { nodeId: h.nodeId || f.replace('.json', ''), ageMs: age, alive: age < STALE_MS };
  });
}

// ---------- tasks ----------

function listTasks() {
  const out = [];
  for (const [dir, scope] of [[path.join(DIRS.inbox, NODE_ID), 'direct'], [path.join(DIRS.inbox, 'broadcast'), 'broadcast']]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const t = readJSON(path.join(dir, f));
      if (t) out.push({ ...t, scope, file: path.join(dir, f) });
    }
  }
  return out.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
}

function claimed(taskId) {
  const p = path.join(DIRS.claims, taskId);
  if (!fs.existsSync(p)) return null;
  return readJSON(p, { _raw: fs.readFileSync(p, 'utf8') });
}

/**
 * THE LOCK: write the claim, commit, then push. A rejected push means another
 * node won the race -> roll back our commit and back off.
 */
function claim(task) {
  ensureDirs();
  syncFromOrigin();
  if (claimed(task.taskId)) return { ok: false, reason: 'already-claimed' };

  const claimPath = path.join(DIRS.claims, task.taskId);
  writeJSON(claimPath, { taskId: task.taskId, nodeId: NODE_ID, claimedAt: new Date().toISOString() });

  tryGit(['add', claimPath]);
  const c = tryGit(['commit', '-m', `claim(${task.taskId}) by ${NODE_ID}`]);
  if (!c.ok && !/nothing to commit/.test(c.out)) return { ok: false, reason: 'commit-failed', detail: c.out };

  const push = tryGit(['push', 'origin', 'HEAD:cline/xe92gsgj']);
  if (!push.ok) {
    tryGit(['reset', '--hard', 'HEAD~1']);   // undo losing claim
    syncFromOrigin();
    return { ok: false, reason: 'race-lost', detail: push.out.split('\n')[0] };
  }
  return { ok: true };
}

function execute(task) {
  log(`executing ${task.taskId}: ${task.title}`);
  return {
    taskId: task.taskId,
    nodeId: NODE_ID,
    status: 'done',
    title: task.title,
    payload: task.payload ?? null,
    output: `ack:${task.taskId}`,   // real work plugs in here
    finishedAt: new Date().toISOString(),
  };
}

function publish(result) {
  writeJSON(path.join(DIRS.outbox, NODE_ID, `${result.taskId}.result.json`), result);
}

function markProcessed(taskId) {
  const s = readJSON(statePath(), { nodeId: NODE_ID, processed: [] });
  s.processed = [...new Set([...(s.processed || []), taskId])];
  s.lastTaskId = taskId;
  s.updatedAt = new Date().toISOString();
  writeJSON(statePath(), s);
}

// ---------- main loop ----------

async function run({ once = false } = {}) {
  ensureDirs();
  if (!fs.existsSync(identityPath())) init();
  syncFromOrigin();

  const state = readJSON(statePath(), { processed: [] });
  log(`rejoined as ${NODE_ID}; already processed ${(state.processed || []).length} task(s)`);
  heartbeat();

  const hbTimer = setInterval(() => heartbeat(), HEARTBEAT_MS);
  const stop = () => { clearInterval(hbTimer); log('shutdown'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    syncFromOrigin();
    const seen = new Set(readJSON(statePath(), { processed: [] }).processed || []);
    const next = listTasks().find((t) => !seen.has(t.taskId) && !claimed(t.taskId));

    if (!next) {
      if (once) { log('nothing to do (--once)'); break; }
      await sleep(POLL_MS);
      continue;
    }

    const got = claim(next);
    if (!got.ok) { log(`did not get ${next.taskId}: ${got.reason}`); await sleep(POLL_MS); continue; }

    const result = execute(next);
    publish(result);
    markProcessed(next.taskId);
    commitAndPush(`node(${NODE_ID}): result for ${next.taskId}`);
    log(`published ${next.taskId}`);
    if (once) break;
  }
  clearInterval(hbTimer);
}

// ---------- submit / status ----------

function submit(title, { to = 'broadcast' } = {}) {
  ensureDirs();
  const taskId = `t-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const task = { taskId, title, payload: null, createdAt: new Date().toISOString(), submittedBy: NODE_ID };
  writeJSON(path.join(DIRS.inbox, to, `${taskId}.json`), task);
  commitAndPush(`submit(${taskId}) -> ${to}`);
  log(`submitted ${taskId} (${to}): ${title}`);
  return taskId;
}

function status() {
  const s = readJSON(statePath(), null);
  const d = readJSON(identityPath(), null);
  console.log('\n--- node ---');
  console.log(d ? `${d.nodeId}  caps=${(d.capabilities || []).join(',')}  keyInjected=${d.keyInjected}` : 'uninitialized');
  console.log('\n--- state ---');
  console.log(s ? `processed=${(s.processed || []).length} last=${s.lastTaskId || 'none'}` : 'no state');
  const open = listTasks().filter((t) => !claimed(t.taskId));
  console.log('\n--- open tasks ---');
  console.log(open.length ? open.map((t) => `  ${t.taskId}  [${t.scope}]  ${t.title}`).join('\n') : '  (none)');
  const p = peers();
  console.log('\n--- peers ---');
  console.log(p.length ? p.map((x) => `  ${x.nodeId}  ${x.alive ? 'alive' : 'stale'}  ${Math.round(x.ageMs / 1000)}s`).join('\n') : '  (none)');
  console.log('');
}

// ---------- cli ----------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init': return init();
    case 'run': return run({ once: rest.includes('--once') });
    case 'submit': return submit(rest.filter((a) => !a.startsWith('--')).join(' '));
    case 'status': return status();
    default:
      console.log('usage: node swarm/node.js <init|submit "..."|run [--once]|status>');
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { init, run, submit, status, claim, listTasks, NODE_ID };
