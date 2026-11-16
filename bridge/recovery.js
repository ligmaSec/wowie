'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function atomicDurable(file, content) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    // Windows does not support opening directories for fsync. The replaced file
    // itself has already been flushed; POSIX also flushes the directory entry.
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

const requestKey = job => JSON.stringify([job.session || '', job.nonce]);
const generationKey = job => JSON.stringify([job.chat || `@${job.session || ''}`, job.generation]);
const ownerKey = job => JSON.stringify([job.session || '', job.chat || '']);
function snapshotJob(job) {
  const { contextTimer, contextWatcher, finished, ...saved } = job;
  return JSON.parse(JSON.stringify(saved));
}

class Journal {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot recover request journal ${file}: ${err.message}`);
      this.data = { version: 1, requests: {}, tombstones: {}, owners: {}, controls: {}, offers: {}, seenSessions: {}, generations: {} };
    }
    if (this.data.version !== 1 || !['requests', 'tombstones', 'owners', 'controls', 'offers', 'seenSessions', 'generations'].every(k => this.data[k] && typeof this.data[k] === 'object' && !Array.isArray(this.data[k]))) {
      throw new Error(`Invalid request journal ${file}; refusing to replay uncertain work`);
    }
    for (const key of ['requests', 'tombstones', 'owners', 'controls', 'offers', 'seenSessions', 'generations']) {
      this.data[key] = Object.assign(Object.create(null), this.data[key]);
    }
  }
  save() { atomicDurable(this.file, JSON.stringify(this.data)); }
  get(job) { return this.data.requests[requestKey(job)]; }
  forgotten(job) { return !!this.data.tombstones[generationKey(job)]; }
  owns(job) { return this.data.owners[ownerKey(job)] === job.nonce && !this.forgotten(job); }
  checkpoint(job, phase, extra = {}) {
    const key = requestKey(job);
    const entry = this.data.requests[key] || { accepted: Date.now() };
    const saved = snapshotJob(job);
    if (phase === 'complete') { delete saved.profilePayload; delete saved.continuation; delete saved.contextNotes; delete saved.contextDenied; }
    Object.assign(entry, extra, { job: saved, phase, updated: Date.now() });
    this.data.requests[key] = entry;
    this.save();
    return entry;
  }
  retain() {
    const groups = new Map();
    for (const entry of Object.values(this.data.requests)) {
      if (entry.phase !== 'complete') continue;
      const key = entry.job.chat || ownerKey(entry.job);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    for (const entries of groups.values()) {
      entries.sort((a, b) => b.completed - a.completed);
      for (const entry of entries.slice(200)) {
        if (!entry.acknowledged) continue;
        delete entry.result;
        delete entry.query;
        const { session, chat, nonce, generation, id, cwd, agent } = entry.job;
        entry.job = { session, chat, nonce, generation, id, cwd, agent };
        entry.phase = 'expired';
      }
    }
  }
}
module.exports = { Journal, atomicDurable, requestKey, generationKey, ownerKey };
