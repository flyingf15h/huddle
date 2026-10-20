// npm run build, then node dev-server.cjs: a local huddle server on :7788 that serves web/dist at /app,
// seeded with a small team. It prints a project and token; open /app#project=P&token=T&name=kelly
const fs = require('fs'), path = require('path');
const real = fs.readFileSync;
const dist = path.join(__dirname, 'dist', 'index.html');
fs.readFileSync = (f, ...a) => (String(f).endsWith('src/dashboard.html') ? real(dist, ...a) : real(f, ...a));
const { createServer } = require(require('path').join(__dirname, '..', 'src', 'server.js'));
const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'huddle-dev-'));
const s = createServer({ dataDir: dir, token: 'admin', open: true, emailDev: true });
s.listen(7788, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:7788';
  const made = await (await fetch(base + '/api/new', { method: 'POST', body: '{"name":"acme-shop"}', headers: { 'content-type': 'application/json' } })).json();
  const call = (n, ep, body) => fetch(`${base}/api/p/${made.project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + made.token, 'content-type': 'application/json' }, body: body ? JSON.stringify({ agent: { id: n + '#a', name: n, kind: 'agent', host: 'x' }, ...body }) : undefined }).then(r => r.json());
  for (const [n, tool] of [['maya', 'claude'], ['dev', 'codex'], ['sam', 'cursor']]) { await call(n, 'hello', { tool, runner: 'full' }); await call(n, 'usage', { five: 30 }); }
  await call('maya', 'status', { status: 'Building the Apple Pay button' });
  const g = await call('kelly', 'goal', { text: 'Add Apple Pay to checkout so iPhone customers pay in one tap' });
  await call('maya', 'claim-goal', { id: g.goal.id });
  const plan = await call('maya', 'plan', { goalId: g.goal.id, title: 'Apple Pay at checkout', tasks: [{ title: 'Apple Pay button', owner: 'maya', effort: 'medium' }, { title: 'Session endpoint', owner: 'dev', effort: 'medium' }, { title: 'Domain file', owner: 'sam', effort: 'light' }] });
  await call('maya', 'task-update', { id: plan.tasks[0].id, status: 'doing' });
  await call('sam', 'task-update', { id: plan.tasks[2].id, status: 'blocked', note: 'Needs the Apple developer login.' });
  await call('dev', 'task-update', { id: plan.tasks[1].id, status: 'done', checks: { review: 'ok', tests: 'passed' } });
  await call('dev', 'stats', { conversation: true, turns: 1, activeMs: 600000, task: plan.tasks[1].id, usage: { 'claude-opus-5-5': { input: 200000, output: 30000, cacheRead: 900000, cacheWrite: 50000, messages: 9 } } });
  await call('maya', 'activity', { items: [{ kind: 'prompt', text: "Build the Apple Pay button using dev's endpoint" }, { kind: 'tool', tool: 'Read', text: 'Read: src/api/payments.ts' }, { kind: 'tool', tool: 'Edit', text: 'Edit: src/checkout/ApplePayButton.tsx' }, { kind: 'text', text: 'The button shows on Safari with the cart total.\n\nNext I am wiring up the payment sheet.' }] });
  await call('dev', 'message', { to: 'maya', text: 'POST /api/payments/apple-session returns { merchantSession }.' });
  await call('maya', 'content', { path: 'src/checkout/ApplePayButton.tsx', branch: 'main', content: 'export const x = 1;\n' });
  await call('dev', 'conflicts', { branch: 'main', items: [{ other: 'maya/main', files: ['src/cart.ts'] }] });
  console.log('ready', made.project, made.token);
});
