// Team & settings: people and access, rules, integrations (GitHub), notifications, data, audit log.
import { useEffect, useState } from 'react';
import { S, auth, known, saveKnown, api, loadMe, loadNotes, isOwner, dn, prettyProject, forgetProject, goHome, people } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { ago, store } from '../lib/words.js';
import Avatar from '../components/Avatar.jsx';
import Icon from '../components/Icon.jsx';
import DigestSettings from '../components/DigestSettings.jsx';
import Automations from '../components/Automations.jsx';
import SlackSetup from '../components/SlackSetup.jsx';
import ThemePicker from '../components/ThemePicker.jsx';
import Editors from '../components/Editors.jsx';

const TABS = [['team', 'Team & access'], ['rules', 'Rules'], ['integrations', 'Integrations'], ['notify', 'Notifications'], ['look', 'Appearance'], ['data', 'Data & privacy'], ['audit', 'Audit log']];
const ROLE = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };
const KINDS = { approval: 'Needs approval', stuck: 'Task stuck', done: 'Request done', failed: 'Something failed', member: 'Someone joined', budget: 'Budget alert', cost: 'Cost spike or forecast', digest: 'Daily digest' };
const lines = (t) => t.split('\n').map(x => x.trim()).filter(Boolean);
const iAmDemo = () => !!store.get('huddle.demo.' + auth.project);
const groupOf = (e) => e.action === 'command' ? 'commands' : ['owner', 'invite', 'invite-revoke', 'join', 'remove', 'role', 'github', 'account'].includes(e.action) ? 'access' : 'changes';

function Toggle({ label, sub, on, onChange, first, disabled }) {
  return <div className="switchrow" style={first ? { borderTop: 0 } : undefined}><span className="grow"><b>{label}</b><span>{sub}</span></span><button className="toggle" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}></button></div>;
}

export default function Settings() {
  useS();
  const [tab, setTab] = useState(S.settingsTab || 'team');
  const [members, setMembers] = useState([]), [invites, setInvites] = useState([]), [audit, setAudit] = useState([]), [afilter, setAfilter] = useState('all'), [msg, setMsg] = useState({});
  const ps = S.projectSettings || {};
  const [pol, setPol] = useState({ allow: '', deny: '', priv: '', sharing: 'full', delivery: 'merge', test: '' });
  const [nUrl, setNUrl] = useState(''), [nEvents, setNEvents] = useState(Object.fromEntries(Object.keys(KINDS).map(k => [k, k !== 'done']))), [repoText, setRepoText] = useState(''), [repoToken, setRepoToken] = useState('');
  const [ret, setRet] = useState({ activityDays: '', messageDays: '', auditDays: '', taskDays: '' }), [delName, setDelName] = useState('');
  const owner = isOwner();
  const say = (k, t, bad) => setMsg(m => ({ ...m, [k]: t ? { t, bad } : null }));
  const run = (k, fn) => async (...a) => { say(k, ''); try { await fn(...a); } catch (e) { say(k, "Couldn't save: " + e.message, true); } };

  useEffect(() => { if (S.settingsTab) { setTab(S.settingsTab); S.settingsTab = null; } });
  // rules mirror what the server has, until the person edits
  useEffect(() => {
    const p = ps.policy || {}, r = ps.retention || {};
    setPol({ allow: (p.allow || []).join('\n'), deny: (p.deny || []).join('\n'), priv: (ps.privatePaths || ['.env', '.env.*', '**/.env', '**/.env.*', '.dev.vars', '*.pem', '*.key', 'secrets/']).join('\n'), sharing: ps.maxSharing || 'full', delivery: ps.delivery || 'merge', test: ps.testCommand || '' });
    setRet({ activityDays: r.activityDays || '', messageDays: r.messageDays || '', auditDays: r.auditDays || '', taskDays: r.taskDays || '' });
  }, [JSON.stringify([ps.policy, ps.privatePaths, ps.maxSharing, ps.delivery, ps.testCommand, ps.retention])]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadTab() {
    try {
      await loadMe();
      if (tab === 'team' && S.me.accounts) { setMembers((await api('members')).members); setInvites(S.me.role === 'owner' ? (await api('invites')).invites : []); }
      if (tab === 'audit' && S.me.role !== 'viewer') setAudit((await api('audit?limit=300')).audit);
      if (tab === 'notify') await loadNotes();
    } catch (e) { say('load', e.message, true); }
  }
  useEffect(() => { loadTab(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- team ----
  const setup = run('setup', async () => { const r = await api('setup-owner', {}); auth.token = r.token; known[auth.project] = r.token; saveKnown(); await loadTab(); });
  const setRole = async (name, role) => { await api('member-role', { name, role }); await loadTab(); };
  const removeMember = async (name) => { if (confirm(`Remove ${name} from the project? Their access stops right away.`)) { await api('member-remove', { name }); await loadTab(); } };
  const revoke = async (id) => { await api('invite-revoke', { id }); await loadTab(); };
  const toggle = async (key, on) => {
    if (key === 'sharedToken' && !on && !confirm('Switch the shared invite off? Anyone still using it (including their agents) loses access until they join with a personal invite.')) return;
    await api('project-setting', { [key]: on }); await loadMe();
  };
  // names huddle has seen: fold one person's two names together, or drop someone who left
  const [into, setInto] = useState({});
  const samePerson = run('names', async (from) => { if (!into[from]) return; await api('merge-person', { from, into: into[from] }); say('names', `${from} is now shown as ${into[from]}.`); });
  const forgetName = run('names', async (name) => { if (!confirm(`Remove ${name} from the team list? Their past work stays.`)) return; await api('forget-agent', { name }); say('names', `Removed ${name}.`); });
  const tidyNames = run('names', async () => { const r = await api('tidy', {}); say('names', r.merged && r.merged.length ? `Merged ${r.merged.length} name${r.merged.length === 1 ? '' : 's'} that differed only in capitals.` : 'Nothing to tidy.'); });
  const linkAccount = run('acct', async () => { await api('link-account', {}); say('acct', 'Linked. This project now opens from your account, and you get its notifications by email.'); await loadTab(); await loadNotes(); });
  const soleOwner = S.me.accounts && S.me.via === 'member' && owner && members.length > 1 && members.filter(m => m.role === 'owner').length < 2;
  const leave = async () => {
    if (!confirm(`Leave ${prettyProject(auth.project)}?`)) return;
    try { if (!iAmDemo()) await api('leave', {}); forgetProject(auth.project); goHome(); } catch (e) { say('leave', e.message, true); }
  };

  // ---- rules ----
  const saveRules = run('rules', async () => {
    await api('policy', { allow: lines(pol.allow), deny: lines(pol.deny), privatePaths: lines(pol.priv), maxSharing: pol.sharing });
    await api('project-setting', { delivery: pol.delivery, testCommand: pol.test.trim() });
    say('rules', "Saved. Everyone's agents pick the rules up on their next prompt.");
  });

  // ---- integrations ----
  const connect = run('repo', async () => { const r = await api('repo-connect', { repo: repoText, token: repoToken.trim() || undefined }); setRepoText(''); setRepoToken(''); say('repo', r.repo.webhook ? `Connected ${r.repo.full}, with a webhook.` : `Connected ${r.repo.full}. ${r.repo.webhookError || ''}`); });
  const disconnect = run('repo', async () => { if (confirm('Disconnect the repository? Branches, pull requests and checks stop showing.')) { await api('repo-disconnect', {}); say('repo', 'Disconnected.'); } });
  const ghLink = (scope) => `/auth/github/login?${scope ? 'scope=repo&' : ''}next=${encodeURIComponent('/app#p=' + auth.project + '&v=settings')}`;

  // ---- notifications ----
  const setPref = async (kind, how, on) => { try { const r = await api('note-prefs', { prefs: { [kind]: { [how]: on } } }); S.notePrefs = r.prefs; } catch (e) { say('prefs', e.message, true); } };
  const addChannel = run('chan', async () => { const r = await api('notify-set', { url: nUrl.trim(), events: Object.keys(nEvents).filter(k => nEvents[k]) }); S.projectSettings.notify = r.notify; setNUrl(''); });
  const removeChannel = (id) => run('chan', async () => { const r = await api('notify-set', { remove: id }); S.projectSettings.notify = r.notify; })();
  const testChannel = run('chan', async () => { const r = await api('notify-test', {}); say('chan', `Sent to ${r.sent} channel${r.sent === 1 ? '' : 's'}.`); });

  // ---- data ----
  const download = async (ep, name) => { const j = await api(ep); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };
  const saveRetention = run('ret', async () => { await api('retention', ret); say('ret', 'Saved. Older items are removed now and as time goes on.'); });
  const eraseMe = run('erase', async () => { if (!confirm('Erase your prompts, replies, messages and usage from this project? Tasks you asked for stay.')) return; const r = await api('erase-me', {}); say('erase', `Erased ${r.activity} activity items and ${r.messages} messages.`); });
  const deleteProject = run('del', async () => { await api('delete-project', { confirm: delName }); forgetProject(auth.project); goHome(); });
  const deleteAccount = async () => { if (!confirm('Delete your huddle account? Projects keep the work you did in them.')) return; await fetch('/api/me/delete', { method: 'POST' }); location.href = '/'; };
  const M = ({ k }) => (msg[k] ? <span className={'small' + (msg[k].bad ? ' err' : '')}>{msg[k].t}</span> : null);
  const auditRows = audit.filter(e => afilter === 'all' || groupOf(e) === afilter).reverse();
  const dis = !owner;

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview">
        <div className="seg ptabs" role="tablist" style={{ flexWrap: 'wrap' }}>{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {msg.load && <p className="err">{msg.load.t}</p>}

        {tab === 'team' && (
          <>
            {!S.me.accounts ? (
              <div className="panel"><h3>Personal access</h3><p className="pdesc">Right now everyone joins with one shared invite, and anyone who has it is in. Set up accounts to give each person their own access with a role (owner, member or viewer) that you can change or take back at any time.</p>
                <div className="pbody"><button className="primary" onClick={setup}>Set up accounts</button> <span className="small muted" style={{ marginLeft: 8 }}>You become the owner. Everyone else keeps working until you switch the shared invite off.</span> <M k="setup" /></div></div>
            ) : (
              <>
                <div className="panel"><h3>People</h3><p className="pdesc">Removing someone stops their access at once, including any agent sessions they have open.</p>
                  <div className="plist">{members.map(m => (
                    <div className="srow" key={m.name}><Avatar name={m.name} sm /><span className="grow"><b>{dn(m.name)}</b>{m.name === S.me.name && <> <span className="muted">(you)</span></>}<span className="sub">{m.github ? 'GitHub ' + m.github + ' · ' : ''}{m.lastSeen ? 'active ' + ago(m.lastSeen) : 'not seen yet'}</span></span>
                      {owner ? <><select aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => setRole(m.name, e.target.value)}>{Object.entries(ROLE).map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select>{m.name !== S.me.name && <button className="ghost" onClick={() => removeMember(m.name)}>Remove</button>}</> : <span className="pill">{ROLE[m.role]}</span>}
                      {m.name === S.me.name && <button className="ghost" onClick={() => (S.profile = true)}>Edit profile</button>}</div>))}</div></div>
                {owner && (
                  <>
                    <div className="panel"><h3>Open invites</h3><p className="pdesc">Each personal invite works for one person (unless you made it for more) and expires after a week.</p>
                      <div className="plist">{invites.map(i => <div className="srow" key={i.id}><span className="pill">{ROLE[i.role]}</span><span className="grow">{i.maxUses - i.uses} use{i.maxUses - i.uses === 1 ? '' : 's'} left<span className="sub">made by {i.by} {ago(i.at)} · expires {new Date(i.expires).toLocaleDateString()}</span></span><button className="ghost" onClick={() => revoke(i.id)}>Take back</button></div>)}
                        {!invites.length && <div className="srow muted">No open invites. Make one with Invite people.</div>}</div></div>
                    <div className="panel"><h3>Access</h3>
                      <Toggle first label="The shared invite still works" sub="Turn this off once everyone has their own access. Then only personal invites work." on={S.me.sharedToken} onChange={(v) => toggle('sharedToken', v)} />
                      <Toggle label="Members can invite people" sub="Members can invite other members and viewers. Only owners can invite owners." on={S.me.membersCanInvite} onChange={(v) => toggle('membersCanInvite', v)} /></div>
                  </>
                )}
              </>
            )}
            {S.account.user && S.me.accounts ? (
              <div className="panel"><h3>Your account</h3><p className="pdesc">Signed in as <b>{S.account.user.email || S.account.user.login}</b>. Linking it opens this project from any browser and sends your notifications to your email.</p>
                <div className="pbody">{S.contact && S.contact.email ? <span className="pill ok">Linked · {S.contact.email}</span> : <button className="primary" onClick={linkAccount}>Link my account to this project</button>} <M k="acct" /></div></div>
            ) : !S.account.user && (S.account.email || S.account.github) ? (
              <div className="panel"><h3>Sign in</h3><p className="pdesc">Sign in from the home screen to carry your projects between browsers and get email notifications.</p><div className="pbody"><button onClick={goHome}>Go to the home screen</button></div></div>
            ) : null}
            {owner && <div className="panel"><h3>Names on the team</h3><p className="pdesc">Everyone huddle has seen in this project. If one person shows up under two names (a laptop and a desktop, say), fold them together. Remove someone who has left; their past work stays.</p>
              <div className="plist">{people().map(p => (
                <div className="srow" key={p.name}><Avatar name={p.name} sm /><span className="grow"><b>{dn(p.name)}</b><span className="sub">{p.online ? 'online now' : 'last seen ' + ago(p.lastSeen)}</span></span>
                  <select aria-label={`Same person as`} value={into[p.name] || ''} onChange={(e) => setInto({ ...into, [p.name]: e.target.value })}><option value="">Same person as…</option>{people().filter(q => q.name !== p.name).map(q => <option key={q.name} value={q.name}>{dn(q.name)}</option>)}</select>
                  <button className="ghost" disabled={!into[p.name]} onClick={() => samePerson(p.name)}>Merge</button>
                  <button className="ghost" disabled={p.online} title={p.online ? 'Online right now' : ''} onClick={() => forgetName(p.name)}>Remove</button></div>))}</div>
              <div className="pactions"><M k="names" /><button onClick={tidyNames}>Merge names that differ only in capitals</button></div></div>}
            <div className="panel"><h3>Leave this project</h3><p className="pdesc">{iAmDemo() ? 'The demo is removed from your projects. You can open a fresh one from the home screen any time.' : soleOwner ? "You're the only owner. Make someone else an owner above first, so the team still has one." : S.me.accounts && S.me.via === 'member' ? "Your access ends right away, and you'd need a new invite to come back. Your past work stays in the project." : 'This project is removed from this browser. Anyone with the shared invite, you included, can still open it again.'} To also disconnect your computer, run <code>huddle leave</code> in the project folder.</p>
              <div className="pactions" style={{ paddingTop: 12 }}><M k="leave" /><button className="danger" disabled={soleOwner} onClick={leave}>Leave {prettyProject(auth.project)}</button></div></div>
          </>
        )}

        {tab === 'rules' && (
          <>
            <div className="panel"><h3>Commands</h3><p className="pdesc">One command per line, matched from the start (<code>npm test</code> also covers <code>npm test -- --watch</code>; end with <code>*</code> for any subcommand).</p>
              <div className="pbody fieldset">
                <div><label htmlFor="pa">Always allowed in background runs</label><textarea id="pa" value={pol.allow} onChange={(e) => setPol({ ...pol, allow: e.target.value })} disabled={dis} placeholder={'npm test\nnpm run build'} /><div className="hintline">Background agents run these without asking anyone.</div></div>
                <div><label htmlFor="pd">Never allowed, for anyone's agent</label><textarea id="pd" value={pol.deny} onChange={(e) => setPol({ ...pol, deny: e.target.value })} disabled={dis} placeholder={'git push\nnpx wrangler deploy'} /><div className="hintline">Refused in every teammate's own sessions too, and can't be approved.</div></div></div></div>
            <div className="panel"><h3>Privacy</h3><div className="pbody fieldset">
              <div><label htmlFor="pp">Private files</label><textarea id="pp" value={pol.priv} onChange={(e) => setPol({ ...pol, priv: e.target.value })} disabled={dis} /><div className="hintline">Never locked, live-shared or shown in Code. A trailing <code>/</code> is a folder; <code>**/</code> matches any depth.</div></div>
              <div><span className="lbl2">Most a session may share</span><div className="seg sm" role="group" aria-label="Most a session may share">{[['full', 'Everything'], ['tools', 'Steps only'], ['off', 'Nothing']].map(([k, l]) => <button key={k} className={pol.sharing === k ? 'on' : ''} disabled={dis} onClick={() => setPol({ ...pol, sharing: k })}>{l}</button>)}</div>
                <div className="hintline">Everything: prompts, replies and steps. Steps only: which tools ran, no prompts or replies. Each person can share less than this, never more. API keys and passwords are hidden either way.</div></div></div></div>
            <div className="panel"><h3>Review before it lands</h3>
              <Toggle first label="A second agent reviews background work" sub="Reads the changes and fixes what it finds before tests run." on={ps.review !== false} onChange={(v) => toggle('review', v)} disabled={dis} />
              <Toggle label="Ask a different vendor when the team has one" sub="If some of you use Codex or Cursor as well as Claude, the review comes from another vendor than the one that wrote the code. Needs that vendor's command line on the computer doing the work." on={ps.crossReview !== false} onChange={(v) => toggle('crossReview', v)} disabled={dis} /></div>
            <div className="panel"><h3>Finished background work</h3><div className="pbody fieldset">
              <div><div className="seg sm" role="group" aria-label="Delivery">{[['merge', "Merge into the person's branch"], ['pr', 'Open a GitHub pull request']].map(([k, l]) => <button key={k} className={pol.delivery === k ? 'on' : ''} disabled={dis} onClick={() => setPol({ ...pol, delivery: k })}>{l}</button>)}</div>
                <div className="hintline">Pull requests need the <code>gh</code> CLI, signed in, on each computer that runs background work. The review and test results go in the description.</div></div>
              <div><label htmlFor="pt">Test command</label><input type="text" id="pt" value={pol.test} onChange={(e) => setPol({ ...pol, test: e.target.value })} disabled={dis} placeholder="Guessed from the project (npm test, pytest, …)" /><div className="hintline">Runs before background work lands. Failing work stays on its branch.</div></div></div></div>
            {owner ? <div className="pactions"><M k="rules" /><button className="primary" onClick={saveRules}>Save rules</button></div> : <p className="readonly-note">Only the project owner can change these.</p>}
          </>
        )}

        {tab === 'integrations' && (
          <div className="panel"><h3><Icon name="github" size={16} /> GitHub repository</h3>
            <p className="pdesc">Connect the project's repository to see branches with their checks, pull requests, commits and issues in Code, get an update the moment someone pushes, close board tasks with commits that say "closes &lt;id&gt;", and open pull requests from huddle.</p>
            {ps.repo ? (
              <div className="srow"><span className="grow"><b><a href={ps.repo.url} target="_blank" rel="noopener noreferrer">{ps.repo.full}</a></b><span className="sub">Connected by {ps.repo.by} {ago(ps.repo.at)} · {ps.repo.webhook ? 'webhook active: updates arrive as people push' : (ps.repo.webhookError || 'read every minute')}</span></span>{owner && <button className="ghost" onClick={disconnect}>Disconnect</button>}</div>
            ) : owner ? (
              <>
                <div className="pbody fieldset">
                  <div><label htmlFor="rr">Repository</label><input id="rr" type="text" value={repoText} onChange={(e) => setRepoText(e.target.value)} placeholder="owner/name or https://github.com/owner/name" /></div>
                  <div><span className="lbl2">Access</span>
                    {S.account.user && S.account.user.repoAccess ? <div className="hintline" style={{ margin: '0 0 6px' }}>Using your signed-in GitHub account ({S.account.user.login}). Leave the token empty.</div>
                      : S.account.github ? <><a className="ghbtn" style={{ display: 'inline-flex' }} href={ghLink(true)}><Icon name="github" size={16} />{S.account.user ? 'Allow repository access' : 'Sign in with GitHub and allow repository access'}</a><div className="hintline">Or paste a token below.</div></> : null}
                    <input type="password" value={repoToken} onChange={(e) => setRepoToken(e.target.value)} placeholder="Personal access token (repo scope), optional" autoComplete="off" aria-label="Personal access token" />
                    <div className="hintline">The token stays on the server, is never shown to the team, and is used only to read the repository and open pull requests. A token with admin rights lets huddle add a webhook.</div></div></div>
                <div className="pactions"><M k="repo" /><button className="primary" onClick={connect} disabled={!repoText.trim()}>Connect</button></div>
              </>
            ) : <p className="readonly-note">Only the project owner can connect a repository.</p>}
            {ps.repo && msg.repo && <p className={'small' + (msg.repo.bad ? ' err' : '')} style={{ padding: '0 16px 12px' }}>{msg.repo.t}</p>}
          </div>
        )}

        {tab === 'integrations' && <Editors />}
        {tab === 'integrations' && <SlackSetup />}
        {tab === 'integrations' && <Automations />}

        {tab === 'look' && (
          <div className="panel"><h3>Theme</h3><p className="pdesc">Only changes how huddle looks in this browser.</p>
            <div className="pbody"><ThemePicker /></div></div>
        )}

        {tab === 'notify' && (
          <>
            <DigestSettings />
            <div className="panel"><h3>What you're told about</h3><p className="pdesc">Your own settings. Everything shows in the bell; choose what also goes to your email{S.contact && S.contact.email ? ` (${S.contact.email})` : ''} and your desktop. Several emails close together are sent as one.</p>
              {!(S.contact && S.contact.email) && <div className="srow" style={{ borderTop: '1px solid var(--line)' }}><span className="grow muted">No email linked. Sign in on the home screen, then link your account under Team &amp; access.</span></div>}
              <div className="plist">{Object.entries(S.noteKinds).map(([k, d]) => { const pr = S.notePrefs[k] || {}; return (
                <div className="srow" key={k}><span className="grow">{d.label}</span>
                  <label className="checks" style={{ gap: 6 }}><input type="checkbox" checked={!!pr.email} disabled={!(S.contact && S.contact.email)} onChange={(e) => setPref(k, 'email', e.target.checked)} />Email</label>
                  <label className="checks" style={{ gap: 6 }}><input type="checkbox" checked={!!pr.desktop} onChange={(e) => setPref(k, 'desktop', e.target.checked)} />Desktop</label></div>); })}</div>
              <p className="small err" style={{ padding: '0 16px' }}>{msg.prefs && msg.prefs.t}</p></div>
            <div className="panel"><h3>Team channels</h3><p className="pdesc">Posts to Slack, Discord or any webhook when something needs a person. The address is kept on the server and never shown to the team.</p>
              <div className="plist">{(ps.notify || []).map(n => <div className="srow" key={n.id}><span className="pill acc">{({ slack: 'Slack', discord: 'Discord', generic: 'Webhook' })[n.kind] || n.kind}</span><span className="grow">{n.label}<span className="sub">{n.events.map(e => KINDS[e] || e).join(' · ')}</span></span>{owner && <button className="ghost" onClick={() => removeChannel(n.id)}>Remove</button>}</div>)}
                {!(ps.notify || []).length && <div className="srow muted">No channels yet.</div>}</div>
              {(ps.notify || []).length > 0 && owner && <div className="pactions"><span className="small">{msg.chan && msg.chan.t}</span><button onClick={testChannel}>Send a test</button></div>}</div>
            {owner && <div className="panel"><h3>Add a channel</h3><div className="pbody fieldset">
              <div><label htmlFor="nu">Webhook URL</label><input type="url" id="nu" value={nUrl} onChange={(e) => setNUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" /><div className="hintline">Slack: an incoming webhook. Discord: Server settings → Integrations → Webhooks. Anything else gets JSON.</div></div>
              <div><span className="lbl2">Send when</span><div className="checks">{Object.entries(KINDS).map(([k, l]) => <label key={k}><input type="checkbox" checked={!!nEvents[k]} onChange={(e) => setNEvents({ ...nEvents, [k]: e.target.checked })} />{l}</label>)}</div></div></div>
              <div className="pactions"><span className="small err">{msg.chan && msg.chan.bad ? msg.chan.t : ''}</span><button className="primary" onClick={addChannel} disabled={!nUrl.trim()}>Add channel</button></div></div>}
          </>
        )}

        {tab === 'data' && (
          <>
            <div className="panel"><h3>What huddle keeps</h3><p className="pdesc">Per project: the board, messages, what agents were asked and replied (secrets are removed first), shared files and code snapshots, memory, usage counts, and the audit log. Nothing is used to train models or shared outside the project. API keys, tokens and webhook addresses are stored server-side and never exported.</p></div>
            {owner && (
              <>
                <div className="panel"><h3>Export</h3><p className="pdesc">Everything the project holds, as one JSON file, without secrets.</p><div className="pbody"><button onClick={() => download('export', prettyProject(auth.project) + '-export.json')}>Download the project</button></div></div>
                <div className="panel"><h3>How long it's kept</h3><p className="pdesc">Leave a box empty to keep that kind of data until the project is deleted. Older items are removed automatically.</p><div className="pbody fieldset">
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{[['activityDays', 'Agent activity'], ['messageDays', 'Messages'], ['auditDays', 'Audit log'], ['taskDays', 'Finished tasks']].map(([k, l]) => <div key={k}><label htmlFor={'r' + k}>{l} (days)</label><input id={'r' + k} type="number" min="1" max="3650" value={ret[k]} onChange={(e) => setRet({ ...ret, [k]: e.target.value })} style={{ width: 120 }} placeholder="Forever" /></div>)}</div></div>
                  <div className="pactions"><M k="ret" /><button className="primary" onClick={saveRetention}>Save</button></div></div>
              </>
            )}
            <div className="panel"><h3>Your data in this project</h3><p className="pdesc">Erase your prompts, replies, messages, hand-off notes, usage and notification settings. Tasks you asked for stay, and the audit log keeps its record of changes.</p>
              <div className="pactions" style={{ paddingTop: 12 }}><M k="erase" /><button className="danger" onClick={eraseMe}>Erase my activity</button></div></div>
            {S.account.user && <div className="panel"><h3>Your account</h3><p className="pdesc">{S.account.user.email || S.account.user.login}. Your projects' access tokens are kept on your account so they follow you between browsers.</p>
              <div className="pactions" style={{ paddingTop: 12 }}><a href="/api/me/export" download>Download my account data</a><button className="danger" onClick={deleteAccount}>Delete my account</button></div></div>}
            {owner && <div className="panel" style={{ borderColor: 'var(--bad)' }}><h3>Delete this project</h3><p className="pdesc">Removes the board, messages, files, code snapshots and everything else from the server, for everyone, and cannot be undone. People's own folders keep their files. Type <b>{prettyProject(auth.project)}</b> to confirm.</p>
              <div className="pactions" style={{ paddingTop: 12 }}><span className="small err">{msg.del && msg.del.t}</span><input value={delName} onChange={(e) => setDelName(e.target.value)} placeholder={prettyProject(auth.project)} aria-label="Project name" style={{ width: 200 }} /><button className="danger" disabled={delName !== prettyProject(auth.project) && delName !== auth.project} onClick={deleteProject}>Delete project</button></div></div>}
          </>
        )}

        {tab === 'audit' && (S.me.role === 'viewer' ? <p className="muted">Viewers cannot see the audit log.</p> : (
          <>
            <div className="seg sm" style={{ marginBottom: 12 }}>{[['all', 'Everything'], ['commands', 'Background commands'], ['access', 'Access'], ['changes', 'Settings and approvals']].map(([k, l]) => <button key={k} className={afilter === k ? 'on' : ''} onClick={() => setAfilter(k)}>{l}</button>)}</div>
            <div className="panel" style={{ overflowX: 'auto' }}><table className="audit"><tbody>{auditRows.map((e, i) => <tr key={i}><td title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>{e.by}</td><td>{e.action === 'command' ? <>ran <code>{e.detail}</code>{e.agent && <> <span className="muted">({e.agent})</span></>}</> : e.detail}</td></tr>)}
              {!auditRows.length && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing here yet.</td></tr>}</tbody></table></div>
          </>
        ))}
      </div>
    </main>
  );
}
