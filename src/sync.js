// Keeps this checkout in step with the huddle: files locked by agents on other
// checkouts are made read-only and their edits are written in as they happen,
// then write access comes back when the lock is released.
'use strict';
const fs = require('fs');
const path = require('path');
const { sha, CONFIG_DIR } = require('./client');
const { writeShared } = require('./shared');
const gitx = require('./git');

const GUARD_MS = 2000;

class Sync {
  constructor(client, cfg, log = () => {}) {
    this.client = client;
    this.cfg = cfg;
    this.log = log;
    this.me = client.agent.checkout;
    this.dir = path.join(cfg.root, CONFIG_DIR);
    this.modesFile = path.join(this.dir, 'modes.json');
    this.lockFile = path.join(this.dir, 'sync.pid');
    this.modes = readJSON(this.modesFile, {});   // path -> original mode, for files we made read-only
    this.expected = {};                          // path -> hash we expect on disk while protected
    this.snap = {};                              // path -> content at protect time, until the holder shares theirs
    this.locks = {};
    this.seq = 0;
    this.active = false;
    this.stopped = false;
    this.wsOpen = false;
    this.wsRetryAt = 0;   // after a failed WebSocket, long-poll for a while before trying again
    this.onEvent = null;
  }

  abs(p) { return path.join(this.cfg.root, ...p.split('/')); }

  // locks and live copies only matter between people on the same branch
  branch() { return gitx.currentBranch(this.cfg.root); }
  sameBranch(x) { return (x.branch || null) === (this.branch() || null); }
  fileQuery(p) { const b = this.branch(); return b ? { path: p, branch: b } : { path: p }; }

  // Only one syncer per checkout, otherwise two sessions in the same folder fight.
  claim() {
    try {
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) return false;
    } catch {}
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  async start() {
    this.loop().catch(e => this.log('sync stopped: ' + e.message));
    this.guardTimer = setInterval(() => this.active && this.guard(), GUARD_MS);
    this.guardTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.closeWs) this.closeWs();
    clearInterval(this.guardTimer);
    if (this.active) {
      for (const p of Object.keys(this.modes)) this.unprotect(p);
      try { if (Number(fs.readFileSync(this.lockFile, 'utf8')) === process.pid) fs.unlinkSync(this.lockFile); } catch {}
    }
  }

  async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      if (!this.active) {
        if (!this.claim()) { await sleep(15000); continue; }
        this.active = true;
        if (this.onActive) this.onActive();
        this.seq = 0;
      }
      try {
        if (this.seq === 0) await this.catchUp();
        if (typeof WebSocket === 'function' && Date.now() > this.wsRetryAt) {
          if (!(await this.stream())) this.wsRetryAt = Date.now() + 5 * 60 * 1000;
          else backoff = 1000;
          continue;
        }
        const r = await this.client.get('events', { since: this.seq, wait: 25 }, { timeout: 35000 });
        if (r.truncated) { this.seq = 0; continue; }
        for (const ev of r.events) {
          this.seq = ev.seq;
          await this.handle(ev);
          if (this.onEvent) this.onEvent(ev);
        }
        backoff = 1000;
      } catch (e) {
        this.log('sync: ' + e.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  // Live events over a WebSocket (the hosted server). Resolves when the socket
  // closes: true if it was ever open, false if the server doesn't speak it.
  stream() {
    return new Promise((resolve) => {
      const base = this.client.base.replace(/^http/, 'ws');
      const q = new URLSearchParams({ token: this.client.cfg.token, since: String(this.seq), agent: JSON.stringify(this.client.agent) });
      let ws, opened = false, chain = Promise.resolve(), ping;
      try { ws = new WebSocket(`${base}/ws?${q}`); } catch { return resolve(false); }
      const finish = () => { clearInterval(ping); this.wsOpen = false; chain.then(() => resolve(opened)); };
      ws.onopen = () => {
        opened = this.wsOpen = true;
        ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 30000);
      };
      ws.onmessage = (m) => {
        if (m.data === 'pong') return;
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.type === 'snapshot') return;
        if (ev.type === 'truncated') { this.seq = 0; try { ws.close(); } catch {} return; }
        chain = chain.then(async () => {
          if (ev.seq <= this.seq) return;
          this.seq = ev.seq;
          await this.handle(ev);
          if (this.onEvent) this.onEvent(ev);
        }).catch(e => this.log('sync: ' + e.message));
      };
      ws.onclose = finish;
      ws.onerror = () => {};
      this.closeWs = () => { try { ws.close(); } catch {} };
    });
  }

  async catchUp() {
    const s = await this.client.get('state');
    this.lastBranch = this.branch();
    this.locks = {};
    for (const l of s.locks) if (this.sameBranch(l)) this.locks[l.path] = l;
    // drop protection for locks that went away while we weren't looking
    for (const p of Object.keys(this.modes)) {
      if (!this.locks[p] || this.locks[p].checkout === this.me) this.unprotect(p);
    }
    for (const f of s.files) {
      if (f.checkout === this.me || !f.size || !this.sameBranch(f)) continue;
      const local = hashOf(this.abs(f.path));
      if (local === f.hash) continue;
      const lockedElsewhere = this.locks[f.path] && this.locks[f.path].checkout !== this.me;
      try {
        const full = await this.client.get('file', this.fileQuery(f.path));
        if (local === null || full.hashes.includes(local) || lockedElsewhere) this.write(f.path, full.content, full.hashes);
        else this.log(`sync: ${f.path} has local changes that were never shared; leaving it alone`);
      } catch (e) { this.log(`sync: ${f.path}: ${e.message}`); }
    }
    for (const l of Object.values(this.locks)) if (l.checkout !== this.me) this.protect(l.path);
    await this.refreshShared();
    this.fetchGit();
    this.seq = s.seq;
  }

  async refreshShared() {
    try { writeShared(this.cfg.root, await this.client.get('shared'), this.log); }
    catch (e) { this.log('sync: shared knowledge: ' + e.message); }
  }

  // others' published branches land in refs/remotes/huddle/* (never touches the working tree)
  fetchGit() {
    if (this.fetching || !gitx.isRepo(this.cfg.root)) return;
    this.fetching = gitx.fetchAll(this.client, this.cfg.root, this.log)
      .catch(e => this.log('sync: git: ' + e.message))
      .finally(() => { this.fetching = null; });
  }

  async handle(ev) {
    if (ev.type === 'shared') return this.refreshShared();
    if (ev.type === 'git') return this.fetchGit();
    if (ev.type === 'lock') {
      if (!this.sameBranch(ev.lock)) return;
      this.locks[ev.lock.path] = ev.lock;
      if (ev.lock.checkout !== this.me) this.protect(ev.lock.path);
    } else if (ev.type === 'unlock') {
      if (!this.sameBranch(ev)) return;
      delete this.locks[ev.path];
      this.unprotect(ev.path);
    } else if (ev.type === 'file' && ev.file.checkout !== this.me && this.sameBranch(ev.file)) {
      try {
        const full = await this.client.get('file', this.fileQuery(ev.file.path));
        this.write(full.path, full.content, full.hashes);
        if (this.locks[full.path] && this.locks[full.path].checkout !== this.me) this.protect(full.path);
      } catch (e) { this.log(`sync: ${ev.file.path}: ${e.message}`); }
    }
  }

  write(p, content, hashes) {
    const abs = this.abs(p);
    const local = hashOf(abs);
    const target = sha(content);
    if (local === target) { this.expected[p] = target; return; }
    if (local !== null && !(hashes || []).includes(local)) this.backup(p, abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const wasProtected = p in this.modes;
    if (wasProtected) chmod(abs, 0o644 | this.modes[p]);
    fs.writeFileSync(abs, content);
    if (wasProtected) chmod(abs, this.modes[p] & ~0o222);
    this.expected[p] = target;
    delete this.snap[p];
  }

  backup(p, abs) {
    const dest = path.join(this.dir, 'conflicts', `${p}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    this.log(`sync: saved your local copy of ${p} to ${path.relative(this.cfg.root, dest)} before overwriting it`);
  }

  protect(p) {
    if (p.endsWith('/')) return; // a folder lock: edits inside it are refused by the hooks instead
    const abs = this.abs(p);
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (!(p in this.modes)) {
      this.modes[p] = st.mode & 0o7777;
      writeJSON(this.modesFile, this.modes);
    }
    chmod(abs, this.modes[p] & ~0o222);
    if (!this.expected[p]) {
      this.expected[p] = hashOf(abs);
      try { this.snap[p] = fs.readFileSync(abs, 'utf8'); } catch {}
    }
  }

  unprotect(p) {
    if (!(p in this.modes)) return;
    chmod(this.abs(p), this.modes[p]);
    delete this.modes[p];
    delete this.expected[p];
    delete this.snap[p];
    writeJSON(this.modesFile, this.modes);
  }

  // Something on this machine (a shell command, an editor) changed a file another
  // agent holds. Put their version back and keep ours as a conflict copy.
  async guard() {
    // switched branches: drop the old branch's protections and resync from scratch
    if (this.lastBranch !== undefined && this.branch() !== this.lastBranch) {
      for (const p of Object.keys(this.modes)) this.unprotect(p);
      this.lastBranch = this.branch();
      this.seq = 0;
      if (this.closeWs) this.closeWs();
      return;
    }
    for (const p of Object.keys(this.modes)) {
      const abs = this.abs(p);
      const want = this.expected[p];
      const have = hashOf(abs);
      if (!want || have === want) continue;
      try {
        const full = await this.client.get('file', this.fileQuery(p));
        if (have !== full.hash) {
          this.write(p, full.content, []);
          this.log(`sync: ${p} is locked by ${this.locks[p] ? this.locks[p].holderName : 'another agent'}; reverted a local change (copy kept in .huddle/conflicts)`);
        }
        this.expected[p] = full.hash;
      } catch (e) {
        if (e.status === 404 && this.snap[p] != null) {
          // holder hasn't shared an edit yet, so put back what was here when they locked it
          const snap = this.snap[p];
          this.write(p, snap, []);
          this.snap[p] = snap;
          this.log(`sync: ${p} is locked by another agent; reverted a local change (copy kept in .huddle/conflicts)`);
        }
      }
      if (have !== null) chmod(abs, this.modes[p] & ~0o222);
    }
  }
}

function hashOf(abs) { try { return sha(fs.readFileSync(abs, 'utf8')); } catch { return null; } }
function chmod(abs, mode) { try { fs.chmodSync(abs, mode); } catch {} }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJSON(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); }

module.exports = { Sync };
