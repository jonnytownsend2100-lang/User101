import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Short, sortable-ish, prefix-readable identifiers: prd_9f2c1a4b. */
export function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const EMPTY = () => ({
  products: [],
  customers: [],
  orders: [],
  licenses: [],
  events: [],
});

/**
 * A tiny document store. In-memory by default (tests, ephemeral demo), JSON
 * file when a path is given. Writes are atomic (tmp + rename) so a crash
 * mid-save cannot leave a half-written ledger behind.
 */
export class Store {
  constructor({ file = null, data = null } = {}) {
    this.file = file;
    this.data = data ? { ...EMPTY(), ...data } : EMPTY();
  }

  async load() {
    if (!this.file) return this.data;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.data = { ...EMPTY(), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = EMPTY();
    }
    return this.data;
  }

  async save() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    await rename(tmp, this.file);
  }

  all(collection) {
    return this.data[collection] ?? [];
  }

  find(collection, docId) {
    return this.all(collection).find((d) => d.id === docId) ?? null;
  }

  findOne(collection, predicate) {
    return this.all(collection).find(predicate) ?? null;
  }

  insert(collection, doc) {
    const record = { id: doc.id ?? id(collection.slice(0, 3)), ...doc };
    this.all(collection).push(record);
    return record;
  }

  update(collection, docId, patch) {
    const doc = this.find(collection, docId);
    if (!doc) return null;
    Object.assign(doc, patch);
    return doc;
  }

  /** Append-only audit trail. Every state change that touches money lands here. */
  log(type, payload = {}) {
    const event = { id: id('evt'), type, at: new Date().toISOString(), ...payload };
    this.data.events.push(event);
    return event;
  }
}
