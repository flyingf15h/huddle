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
:root { --bg: #f4f7fc; --card: #fff; --ink: #14203a; --muted: #5b6785; --line: #dde4f0; --ok: #1f9d6b; --bad: #d4453a; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1226; --card: #121c38; --ink: #e8eefc; --muted: #93a0c2; --line: #233056; --ok: #3ccf91; --bad: #ff6b5e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 48px 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.banner { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); font-weight: 600; margin-bottom: 16px; }
ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
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
