// The public /status page: is the huddle server up, and how long does a round trip take. Nothing
// about any project is on it.
'use strict';

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function statusPage(info) {
  const checks = info.checks || [{ name: 'API', ok: info.ok }];
  const ok = checks.every(c => c.ok);
  const rows = checks.map(c => `<li><span class="dot ${c.ok ? 'ok' : 'bad'}"></span><span class="n">${esc(c.name)}</span><span class="v">${c.ok ? (c.ms != null ? `${c.ms} ms` : 'Operational') : esc(c.error || 'Down')}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>huddle status</title>
<style>
:root { --bg: #faf7f0; --card: #fffdf8; --ink: #24211c; --muted: #5f5b53; --line: rgba(36, 33, 28, .14); --ok: #1f7a5c; --bad: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1b18; --card: #272420; --ink: #ece5da; --muted: #aaa398; --line: rgba(255, 255, 255, .12); --ok: #5cc49c; --bad: #f07a6a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 48px 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.banner { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-radius: 8px; background: var(--card); border: 1px solid var(--line); font-weight: 600; margin-bottom: 16px; }
ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
li { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
li + li { border-top: 1px solid var(--line); }
.n { flex: 1; } .v { color: var(--muted); font-variant-numeric: tabular-nums; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; } .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
footer { color: var(--muted); font-size: 13px; margin-top: 18px; }
a { color: inherit; }
</style></head><body><main>
<h1>huddle status</h1>
<p class="sub">${esc(info.server || 'huddle')}${info.version ? ` · version ${esc(info.version)}` : ''}</p>
<div class="banner"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${ok ? 'All systems operational' : 'Some systems are having problems'}</div>
<ul>${rows}</ul>
<footer>Checked ${esc(new Date().toUTCString())}${info.since ? ` · up since ${esc(new Date(info.since).toUTCString())}` : ''}${info.github !== undefined ? ` · GitHub sign-in ${info.github ? 'on' : 'off'}` : ''} · <a href="/">Dashboard</a></footer>
</main></body></html>`;
}

module.exports = { statusPage };
