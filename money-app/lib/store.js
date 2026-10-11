/**
 * lib/store.js — tiny durable KV, single writer, atomic writes.
 *
 * Contract: docs/INTERFACE.md §3.6
 *   makeStore({ path = null, clock } = {}) -> Store
 *   store.getJSON(key, fallback = null) -> value
 *   store.setJSON(key, value) -> value
 *   store.delete(key) -> boolean
 *   store.keys(prefix = '') -> string[]
 *   store.flush() -> void
 *
 * No database is required to run the app: `path = null` gives a purely in-memory
 * store, `path = '<file>'` gives a whole-file JSON store whose writes are atomic
 * (tmp file + renameSync) so a torn-down sandbox never leaves half-written JSON.
 *
 * Namespace keys as `<module>/<id>` (`ledger`, `apikeys`, `meter`, `customers`,
 * `queue`, `webhook_events`) — see INTERFACE.md §3.6.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_VERSION = 1;

export class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StoreError';
    this.code = code ?? message;
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StoreError('store key must be a non-empty string', 'bad_key');
  }
}

/** Values handed to callers are copies, so a caller cannot mutate the store by aliasing. */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

export function makeStore({ path = null, clock = () => new Date() } = {}) {
  const filePath = typeof path === 'string' && path.length > 0 ? path : null;
  const data = new Map();
  let writeCount = 0;

  function snapshot() {
    const out = {};
    for (const [key, value] of data) out[key] = clone(value);
    return { version: FORMAT_VERSION, updatedAt: clock().toISOString(), data: out };
  }

  function persist() {
    if (!filePath) return;
    const body = JSON.stringify(snapshot());
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${++writeCount}`;
    try {
      writeFileSync(tmp, body, 'utf8');
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort cleanup; the original error is what matters */
      }
      throw err;
    }
    // rename(2) within the same directory is atomic: readers see either the old
    // file or the complete new one, never a partial write.
    renameSync(tmp, filePath);
  }

  function loadFromDisk() {
    if (!filePath || !existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf8');
    if (raw.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError(`store file is not valid JSON: ${filePath}`, 'corrupt_store');
    }
    const entries =
      parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object'
        ? parsed.data
        : null;
    if (entries === null) {
      throw new StoreError(`store file has an unexpected shape: ${filePath}`, 'corrupt_store');
    }
    data.clear();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
  }

  const api = {
    /** Absolute path backing this store, or null for a memory-only store. */
    get path() {
      return filePath;
    },

    getJSON(key, fallback = null) {
      assertKey(key);
      if (!data.has(key)) return fallback;
      return clone(data.get(key));
    },

    setJSON(key, value) {
      assertKey(key);
      data.set(key, clone(value));
      persist();
      return clone(data.get(key));
    },

    delete(key) {
      assertKey(key);
      const existed = data.delete(key);
      if (existed) persist();
      return existed;
    },

    keys(prefix = '') {
      const out = [];
      for (const key of data.keys()) {
        if (key.startsWith(prefix)) out.push(key);
      }
      return out.sort();
    },

    has(key) {
      assertKey(key);
      return data.has(key);
    },

    flush() {
      persist();
    },

    toJSON() {
      return snapshot();
    },

    load(snap) {
      const entries =
        snap && typeof snap === 'object' && snap.data && typeof snap.data === 'object'
          ? snap.data
          : {};
      data.clear();
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
      return api;
    },
  };

  loadFromDisk();
  return api;
}

export default makeStore;
