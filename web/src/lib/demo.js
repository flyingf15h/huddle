// The demo project: a real project on this server filled with a simulated team (Claude Code, Codex and
// Cursor users), kept moving while the tab is open so every page has something to show.
import { auth, known, saveKnown, S } from './state.js';
import { store } from './words.js';

const DEMO_TEAM = [{ name: 'maya', tool: 'claude', five: 34 }, { name: 'dev', tool: 'codex', five: 71 }, { name: 'sam', tool: 'cursor', five: 12 }];
const demoAgent = (n) => ({ id: `${n}#demo`, name: n, host: 'demo', kind: 'agent' });
export const demoKey = (p) => 'huddle.demo.' + p;
function demoCall(token, project, ep, body) {
  return fetch(`/api/p/${encodeURIComponent(project)}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.status); return j; }));
}
const DEMO_FILES = {
  'src/checkout/ApplePayButton.tsx': "import { startSession } from '../api/payments';\n\n// Shown only on devices that support Apple Pay; everyone else keeps the card form.\nexport function ApplePayButton({ total }: { total: number }) {\n  if (!window.ApplePaySession?.canMakePayments()) return null;\n  return <button className=\"apple-pay\" onClick={() => startSession(total)} aria-label=\"Pay with Apple Pay\" />;\n}\n",
  'src/api/payments.ts': "export async function startSession(totalCents: number) {\n  const res = await fetch('/api/payments/apple-session', { method: 'POST', body: JSON.stringify({ totalCents }) });\n  if (!res.ok) throw new Error('could not start Apple Pay');\n  return (await res.json()).merchantSession;\n}\n",
  'src/cart.ts': "export type Item = { id: string; priceCents: number; qty: number };\n\nexport const total = (items: Item[]) => items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);\n",
  'tests/cart.test.ts': "import { total } from '../src/cart';\n\ntest('adds up the cart', () => {\n  expect(total([{ id: 'a', priceCents: 1250, qty: 2 }])).toBe(2500);\n});\n",
  'README.md': '# acme-shop\n\nThe storefront. `npm run dev` to start, `npm test` to test.\n\n## Checkout\n\nCard payments everywhere, Apple Pay on supported devices.\n',
};
export async function createDemo(status) {
  const me = auth.name || 'you';
  const made = await fetch('/api/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'huddle-demo' }) }).then(r => r.json());
  const P = made.project, T = made.token;
  const as = (n) => (ep, body) => demoCall(T, P, ep, { agent: demoAgent(n), ...(body || {}) });
  const say = (t) => status && status(t);
  say('Bringing in the team…');
  for (const m of DEMO_TEAM) {
    await as(m.name)('hello', { tool: m.tool, runner: 'full', build: { sha: 'demo', at: Date.now() } });
    await as(m.name)('usage', { five: m.five, week: Math.round(m.five / 3) });
    await as(m.name)('stats', { conversation: true, turns: 6 + m.five % 9, activeMs: (20 + m.five) * 60000, usage: { [m.tool === 'codex' ? 'gpt-5.5-codex' : m.tool === 'cursor' ? 'claude-sonnet-5-5' : 'claude-opus-5-5']: { input: 90000 + m.five * 3000, output: 21000, cacheRead: 400000, cacheWrite: 50000, messages: 30 } } });
  }
  await as('maya')('setting', { aiName: 'Pip' });
  say('Writing the project brief…');
  await as('sam')('doc', { text: '# acme-shop\n\nThe online store for Acme. React front end in `src/`, API routes in `src/api/`.\n\n## Conventions\n- Money is always in cents.\n- Every change to checkout needs a test in `tests/`.\n\n## Who owns what\n- maya: checkout UI\n- dev: payments API\n- sam: docs and release', force: true });
  await as('dev')('memory', { title: 'Amounts are in cents', text: 'Every price and total in the API is an integer number of cents. Never send dollars.' });
  await as('maya')('memory', { title: 'Apple Pay only works on https', text: 'Use `npm run dev:https` to test the Apple Pay button locally; plain http hides it.' });
  await as('sam')('memory', { title: 'Release checklist lives in RELEASING.md', text: 'Tag, changelog, then deploy. Ask sam before deploying.' });
  await as('sam')('skill', { name: 'release-notes', description: 'Write release notes from the commits since the last tag', body: 'List the commits since the last tag, group them by area, and write one plain sentence per user-visible change.' });
  say('Handing out the work…');
  const g = await demoCall(T, P, 'goal', { agent: { id: 'human:' + me, name: me, kind: 'human', host: 'dashboard' }, text: 'Add Apple Pay to checkout. Customers on iPhone should be able to pay in one tap, and card payments must keep working.' });
  await as('maya')('claim-goal', { id: g.goal.id });
  const plan = await as('maya')('plan', { goalId: g.goal.id, title: 'Apple Pay at checkout', summary: 'UI, endpoint, domain file, then an end-to-end test.', tasks: [
    { title: 'Apple Pay button on checkout', detail: 'Show the Apple Pay button on supported devices, keep the card form for everyone else.', owner: 'maya', effort: 'medium', paths: ['src/checkout/'] },
    { title: 'Apple Pay session endpoint', detail: 'POST /api/payments/apple-session returns the merchant session.', owner: 'dev', effort: 'medium', paths: ['src/api/payments.ts'] },
    { title: 'Domain verification file', detail: 'Upload the Apple domain verification file.', owner: 'sam', effort: 'light' },
    { title: 'End-to-end test for Apple Pay', detail: 'Cover the happy path and the card fallback.', effort: 'light' } ] });
  const [t1, t2, t3] = plan.tasks;
  await as('maya')('task-update', { id: t1.id, status: 'doing' });
  await as('dev')('task-update', { id: t2.id, status: 'doing', run: { attempt: 1, outcome: 'retrying', ms: 52000, error: 'stream disconnected before completion', agent: 'codex' } });
  await as('dev')('task-update', { id: t2.id, status: 'done', note: 'The endpoint returns { merchantSession }; tests pass.', run: { attempt: 2, outcome: 'ok', ms: 384000, agent: 'codex' }, checks: { review: 'ok', tests: 'passed', testCommand: 'npm test', merged: true } });
  await as('sam')('task-update', { id: t3.id, status: 'blocked', note: "Needs the Apple developer account login, which only a person can do. Waiting for you." });
  const flaky = await demoCall(T, P, 'goal', { agent: { id: 'human:' + me, name: me, kind: 'human', host: 'dashboard' }, text: 'The cart test fails about one run in five. Find out why and fix it.', to: 'dev' });
  const ft = (await demoCall(T, P, 'board')).tasks.find(t => t.goalId === flaky.goal.id);
  await as('dev')('task-update', { id: ft.id, title: 'Fix the flaky cart test', status: 'done', run: { attempt: 1, outcome: 'ok', ms: 241000, agent: 'codex' }, checks: { review: 'ok', tests: 'passed', testCommand: 'npm test', pr: 'https://github.com/acme/shop/pull/128', prState: 'open' }, note: 'Two tests shared one fake clock. Each gets its own now.' });
  const e2e = await demoCall(T, P, 'goal', { agent: demoAgent('maya'), text: 'Run the full end-to-end suite against staging.', to: 'dev' });
  const et = (await demoCall(T, P, 'board')).tasks.find(t => t.goalId === e2e.goal.id);
  await as('dev')('task-update', { id: et.id, title: 'Run e2e suite on staging', status: 'doing' });
  await as('dev')('approval-request', { taskId: et.id, commands: [{ command: 'npm run e2e -- --env staging', why: 'reaches the staging server' }] });
  await as('dev')('stats', { turns: 2, activeMs: 380000, task: t2.id, request: true, usage: { 'gpt-5.5-codex': { input: 640000, output: 52000, cacheRead: 1900000, cacheWrite: 0, messages: 14 } } });
  await as('maya')('stats', { turns: 3, activeMs: 540000, task: t1.id, usage: { 'claude-opus-5-5': { input: 310000, output: 61000, cacheRead: 2400000, cacheWrite: 180000, messages: 22 } } });
  say('Sharing code and messages…');
  for (const [f, text] of Object.entries(DEMO_FILES)) await as(f.startsWith('src/api') ? 'dev' : 'maya')('content', { path: f, branch: 'main', content: text, tool: 'Edit' });
  await as('dev')('unlock', { all: true });
  await as('maya')('unlock', { all: true });
  await as('maya')('lock', { path: 'src/checkout/ApplePayButton.tsx', branch: 'main' });
  const sha = 'de0' + '0'.repeat(37);
  await as('maya')('git-snapshot', { branch: 'main', sha, i: 0, n: 1, files: Object.entries(DEMO_FILES).map(([path, content]) => ({ path, content })) });
  await as('maya')('conflicts', { branch: 'main', items: [{ other: 'dev/main', files: ['src/cart.ts', 'src/api/payments.ts'] }] });
  await as('maya')('status', { status: 'Building the Apple Pay button on checkout' });
  await as('dev')('status', { status: 'Adding refunds to the payments endpoint' });
  await as('sam')('status', { status: 'Updating the README for the new checkout' });
  await as('maya')('activity', { items: [{ kind: 'prompt', text: "Build the Apple Pay button on checkout, using dev's new endpoint" }, { kind: 'tool', tool: 'Read', text: 'Read: src/api/payments.ts' }, { kind: 'tool', tool: 'Edit', text: 'Edit: src/checkout/ApplePayButton.tsx' }, { kind: 'text', text: 'The button now shows on Safari with the cart total, and the card form stays for everyone else. Next I am wiring up the payment sheet.' }] });
  await as('dev')('activity', { items: [{ kind: 'prompt', text: 'why does the cart test fail sometimes' }, { kind: 'tool', tool: 'Bash', text: 'Bash: npm test -- cart --runInBand' }, { kind: 'text', text: 'Two tests shared one fake clock, so whichever ran second saw the wrong time. Each test gets its own now; 50 runs in a row pass.' }, { kind: 'end', text: '' }] });
  await as('maya')('message', { text: "I'm in src/checkout/ for the Apple Pay button. dev, does your endpoint return the merchant session as JSON?" });
  await as('dev')('message', { to: 'maya', text: 'Yes: POST /api/payments/apple-session returns { merchantSession }. Amounts in cents.' });
  await as('sam')('message', { to: me, text: 'The domain verification file needs the Apple developer login. Can you do that one when you are back?' });
  await as('sam')('handoff', { text: 'Was on: README for the new checkout. Next: domain verification once someone has the Apple login.', files: ['README.md'], commits: ['a1b2c3d docs: checkout section'] });
  await as('dev')('problem', { kind: 'crash', message: 'Codex crashed once on "Apple Pay session endpoint"; huddle ran it again and it finished', detail: 'stream disconnected before completion' });
  say('Setting up accounts…');
  const own = await demoCall(T, P, 'setup-owner', { agent: { id: 'human:' + me, name: me, kind: 'human', host: 'dashboard' } });
  for (const [n, role] of [['maya', 'member'], ['dev', 'member'], ['sam', 'member'], ['alex', 'viewer']]) {
    const inv = await demoCall(own.token, P, 'member-invite', { agent: { id: 'human:' + me, name: me, kind: 'human' }, role });
    await demoCall(null, P, 'redeem', { code: inv.code, name: n }).catch(() => {});
  }
  await demoCall(own.token, P, 'policy', { agent: { id: 'human:' + me, name: me, kind: 'human' }, allow: ['npm test', 'npm run typecheck'], deny: ['git push --force', 'npm publish'] });
  store.set(demoKey(P), T);
  return { project: P, token: own.token, name: me };
}

export async function openDemo(status) {
  const d = await createDemo(status);
  known[d.project] = d.token;
  saveKnown();
  store.set('huddle.last', d.project);
  if (!auth.name) { auth.name = d.name; store.set('huddle.name', d.name); }
  location.hash = '#p=' + encodeURIComponent(d.project);
  location.reload();
}
// while a demo is open, its teammates keep working: one small step every few seconds
const DEMO_STEPS = [
  (as) => as('maya')('activity', { items: [{ kind: 'tool', tool: 'Read', text: 'Read: src/checkout/ApplePayButton.tsx' }] }),
  (as, k) => as('maya')('content', { path: 'src/checkout/ApplePayButton.tsx', branch: 'main', tool: 'Edit', content: DEMO_FILES['src/checkout/ApplePayButton.tsx'] + `\n// step ${k}: payment sheet wired up\n` }),
  (as) => as('dev')('activity', { items: [{ kind: 'prompt', text: 'add refunds for Apple Pay orders' }, { kind: 'tool', tool: 'Bash', text: 'Bash: npm test -- payments' }] }),
  (as) => as('dev')('activity', { items: [{ kind: 'text', text: 'Refunds go through the same payment session. 14 payment tests pass.' }, { kind: 'end', text: '' }] }),
  (as) => as('maya')('activity', { items: [{ kind: 'tool', tool: 'Bash', text: 'Bash: npm run typecheck' }] }),
  (as) => as('maya')('message', { to: 'dev', text: 'Your endpoint works on staging. One question: refunds also in cents?' }),
  (as) => as('dev')('message', { to: 'maya', text: 'Yes, cents everywhere, same as card payments.' }),
  (as) => as('sam')('activity', { items: [{ kind: 'prompt', text: 'add the Apple Pay steps to the README' }, { kind: 'tool', tool: 'Edit', text: 'Edit: README.md' }, { kind: 'end', text: '' }] }),
  (as) => as('maya')('activity', { items: [{ kind: 'text', text: 'Checkout shows Apple Pay on supported devices and falls back to the card form everywhere else.' }, { kind: 'end', text: '' }] }),
];
let demoTimer = null;
export function runDemo() {
  const T = store.get(demoKey(auth.project));
  if (!T || demoTimer) return;
  let k = 0;
  const as = (n) => (ep, body) => demoCall(T, auth.project, ep, { agent: demoAgent(n), ...(body || {}) });
  const tick = async () => {
    if (!document.hidden) {
      try { await DEMO_STEPS[k % DEMO_STEPS.length](as, k); for (const m of DEMO_TEAM) await as(m.name)('hello', {}); } catch {}
      k++;
    }
    demoTimer = setTimeout(tick, 6000 + Math.random() * 4000);
  };
  demoTimer = setTimeout(tick, 3000);
}
export const stopDemo = () => { clearTimeout(demoTimer); demoTimer = null; };
