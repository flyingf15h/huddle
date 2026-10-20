// Starting other programs (claude, codex, agent, gh) the same way on every system. On Windows, tools
// installed with npm are .cmd shims, which can't be started directly, and a shell would mangle the long
// multi-line prompts we pass as arguments. So find the shim, read which script it runs, and run that
// with node ourselves. Real .exe files (Claude Code's own installer) are started as they are.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const cache = new Map();

function where(name) {
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}

// { command, prefix } to run `name`: prefix goes before the real arguments
function resolve(name) {
  if (process.platform !== 'win32' || /[\\/]/.test(name)) return { command: name, prefix: [] };
  if (cache.has(name)) return cache.get(name);
  let found = { command: name, prefix: [] };
  const hits = where(name);
  const exe = hits.find(h => /\.(exe|com)$/i.test(h));
  const shim = hits.find(h => /\.(cmd|bat)$/i.test(h));
  if (exe) found = { command: exe, prefix: [] };
  else if (shim) {
    // npm's shim: ... "%dp0%\node_modules\pkg\cli.js" %*   (or "%~dp0name" in hand-made ones)
    let text = '';
    try { text = fs.readFileSync(shim, 'utf8'); } catch {}
    const m = /%~?dp0%?[\\/]?([^"\s%]+)/i.exec(text.split(/\r?\n/).filter(l => /dp0/i.test(l) && !/^\s*(@?set|rem|::)/i.test(l)).join('\n'));
    const script = m && path.resolve(path.dirname(shim), m[1].replace(/\\/g, path.sep));
    if (script && fs.existsSync(script)) found = { command: process.execPath, prefix: [script] };
  }
  cache.set(name, found);
  return found;
}

function start(name, args, opts) { const r = resolve(name); return [r.command, [...r.prefix, ...args]]; }
module.exports = {
  spawn: (name, args, opts) => { const [c, a] = start(name, args); return spawn(c, a, opts); },
  spawnSync: (name, args, opts) => { const [c, a] = start(name, args); return spawnSync(c, a, opts); },
  resolve,
};
