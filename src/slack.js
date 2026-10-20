// Slack, for small teams: a slash command (/huddle) to start requests and see where things stand, and
// messages with buttons for the things that need a person (approvals, stuck work). Every team creates
// its own Slack app from a manifest (a few clicks), so each project keeps its own signing secret and no
// shared Slack app or app review is needed. Web-standard APIs only, so it runs in the Worker and Node.
'use strict';

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// Slack signs "v0:<timestamp>:<raw body>" with the app's signing secret
async function verify(secret, raw, timestamp, signature, nowMs = Date.now()) {
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 60 * 5) return false;
  const key = await subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = 'v0=' + hex(await subtle.sign('HMAC', key, enc(`v0:${timestamp}:${raw}`)));
  if (want.length !== signature.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return d === 0;
}
async function sign(secret, raw, timestamp) {
  const key = await subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'v0=' + hex(await subtle.sign('HMAC', key, enc(`v0:${timestamp}:${raw}`)));
}

// the manifest a team pastes into Slack to make its app (https://api.slack.com/apps?new_app=1)
function manifest(origin, project) {
  return {
    display_information: { name: 'huddle', description: "Start your team's agent work from Slack and answer what needs a person" },
    features: {
      bot_user: { display_name: 'huddle', always_online: false },
      slash_commands: [{ command: '/huddle', url: `${origin}/api/slack/${encodeURIComponent(project)}/command`, description: "Ask your team's agents to do something", usage_hint: 'fix the login redirect | status | help', should_escape: false }],
    },
    oauth_config: { scopes: { bot: ['commands', 'incoming-webhook'] } },
    settings: { interactivity: { is_enabled: true, request_url: `${origin}/api/slack/${encodeURIComponent(project)}/interact` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}
const createUrl = (origin, project) => 'https://api.slack.com/apps?new_app=1&manifest_json=' + encodeURIComponent(JSON.stringify(manifest(origin, project)));

// ---- message pieces ----
const mrkdwn = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } });
const button = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value: String(value), ...(style ? { style } : {}) });
const approvalBlocks = (text, id) => [mrkdwn(text), { type: 'actions', elements: [button('Approve', 'approve', id, 'primary'), button('Decline', 'decline', id, 'danger')] }];
const stuckBlocks = (text, id) => [mrkdwn(text), { type: 'actions', elements: [button('Run again', 'rerun', id), button('Mark done', 'done', id)] }];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// the daily digest as Slack blocks
function digestBlocks(d, link) {
  const out = [{ type: 'header', text: { type: 'plain_text', text: String(d.headline).slice(0, 150) } }];
  for (const s of d.sections.slice(0, 5)) out.push(mrkdwn(`*${esc(s.title)}*\n${s.items.slice(0, 8).map(i => '• ' + esc(i.text)).join('\n')}`));
  if (link) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open the project>` }] });
  return out;
}

// "/huddle @maya fix the login" -> { to: 'maya', text: 'fix the login' }; "to maya: …" works too
function parseRequest(text, known) {
  let t = String(text || '').trim();
  const m = /^(?:to\s+)?@?([\w.-]{2,40})\s*[:,]?\s+([\s\S]+)$/i.exec(t);
  if (m && known.some(k => k.toLowerCase() === m[1].toLowerCase()) && (/^(to\s|@)/i.test(t) || /[:,]/.test(t.slice(m[1].length, m[1].length + 3)))) {
    const to = known.find(k => k.toLowerCase() === m[1].toLowerCase());
    return { to, text: m[2].trim() };
  }
  return { to: null, text: t };
}

module.exports = { verify, sign, manifest, createUrl, approvalBlocks, stuckBlocks, digestBlocks, parseRequest, mrkdwn, esc };
