// What a project lets its Claudes do and share, used the same way by the server, the hooks and the
// background runner: commands every Claude may always run or may never run, files that never leave
// anyone's machine, and secrets taken out of anything shared before it's sent.
'use strict';

// Files that stay on each person's machine unless the owner says otherwise: no lock, no live copy,
// no code-view snapshot. A trailing "/" is a folder; "*" stays within one folder, "**" crosses them.
const DEFAULT_PRIVATE = ['.env', '.env.*', '**/.env', '**/.env.*', '.dev.vars', '**/.dev.vars', '*.pem', '**/*.pem', '*.key', '**/*.key',
  'secrets/', '**/secrets/', '.npmrc', '**/.npmrc', 'id_rsa*', '**/id_rsa*', 'id_ed25519*', '**/id_ed25519*',
  '*.p12', '**/*.p12', '*.pfx', '**/*.pfx', '*.keystore', '**/*.keystore', '*.jks', '**/*.jks',
  '.aws/', '**/.aws/', '.ssh/', '**/.ssh/', '.gnupg/', '**/.gnupg/', '.netrc', '**/.netrc', '.pypirc', '**/.pypirc', '.git-credentials', '**/.git-credentials',
  '.htpasswd', '**/.htpasswd', '*.tfvars', '**/*.tfvars', '*.tfstate', '**/*.tfstate', '*.tfstate.*', '**/*.tfstate.*',
  'credentials*.json', '**/credentials*.json', 'service-account*.json', '**/service-account*.json', 'serviceAccount*.json', '**/serviceAccount*.json',
  'google-services.json', '**/google-services.json', 'GoogleService-Info.plist', '**/GoogleService-Info.plist', 'kubeconfig', '**/kubeconfig'];

function globRe(glob) {
  const g = String(glob).trim().replace(/^\.\//, '');
  const dir = g.endsWith('/');
  let re = '';
  const body = dir ? g.slice(0, -1) : g;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*' && body[i + 1] === '*') { re += body[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += body[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + (dir ? '(?:/.*)?$' : '$'));
}
function pathMatches(globs, rel) {
  if (!rel) return false;
  rel = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  return (globs || []).some(g => { try { return globRe(g).test(rel); } catch { return false; } });
}
function privatePaths(settings) {
  const s = settings || {};
  return Array.isArray(s.privatePaths) ? s.privatePaths : DEFAULT_PRIVATE;
}
function isPrivatePath(settings, rel) { return pathMatches(privatePaths(settings), rel); }

// A command rule is the start of a command, word by word: "npm test" matches "npm test -- --watch",
// "npx wrangler *" matches any wrangler subcommand. A chain ("a && b | c") is checked part by part.
function words(cmd) { return String(cmd || '').trim().split(/\s+/).filter(Boolean); }
function parts(command) {
  return String(command || '').split(/&&|\|\||;|\||\n/).map(s => s.trim().replace(/^\(+|\)+$/g, '').replace(/^(sudo\s+|env\s+(\w+=\S+\s+)*|\w+=\S+\s+)+/, '')).filter(Boolean);
}
function ruleMatches(rule, part) {
  const want = words(rule), have = words(part);
  if (!want.length || want.length > have.length && want[want.length - 1] !== '*') return false;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '*') { if (i === want.length - 1) return true; continue; }
    if (have[i] === undefined) return false;
    if (want[i].includes('*') ? !globRe(want[i]).test(have[i]) : want[i] !== have[i]) return false;
  }
  return true;
}
// the deny rule a command breaks, or null
function deniedBy(policy, command) {
  const deny = (policy && policy.deny) || [];
  for (const part of parts(command)) for (const r of deny) if (ruleMatches(r, part)) return r;
  return null;
}
// true when every part of the command is on the allow list
function allowedBy(policy, command) {
  const allow = (policy && policy.allow) || [];
  const ps = parts(command);
  return !!ps.length && ps.every(part => allow.some(r => ruleMatches(r, part)));
}
function cleanRules(list) {
  return [...new Set((Array.isArray(list) ? list : String(list || '').split('\n')).map(r => String(r).trim().replace(/\s+/g, ' ')).filter(r => r && r.length <= 200))].slice(0, 100);
}

// Secrets taken out of shared text before it leaves the machine (and again on the server). Each
// pattern keeps enough around the secret to say what it was.
const HIDDEN = '[secret hidden]';
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => `-----BEGIN PRIVATE KEY----- ${HIDDEN}`],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, HIDDEN],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g, HIDDEN],
  [/\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, HIDDEN],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, HIDDEN],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, HIDDEN],
  [/\b(h[pm]_[A-Za-z0-9_-]{20,})\b/g, HIDDEN],
  [/\b(npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|dop_v1_[a-f0-9]{40,}|hf_[A-Za-z0-9]{30,})\b/g, HIDDEN],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{24,}=*/gi, `$1${HIDDEN}`],
  [/((?:AccountKey|SharedAccessKey|Password|Pwd)=)[^;\s"']{8,}/gi, `$1${HIDDEN}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, HIDDEN],
  [/(hooks\.slack\.com\/services\/)[\w/]+/g, `$1${HIDDEN}`],
  [/(discord(?:app)?\.com\/api\/webhooks\/)[\w/-]+/g, `$1${HIDDEN}`],
  [/(\/\/[^\s/:@]+:)[^\s/@]+(@)/g, `$1${HIDDEN}$2`],
  [/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'`]{6,})\3/gi,
    (m, k, sep, q, v) => /^(\$|process\.env|os\.environ|env\.|\[secret)/i.test(v) ? m : `${k}${sep}${q}${HIDDEN}${q}`],
];
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let t = text;
  for (const [re, to] of SECRET_PATTERNS) t = t.replace(re, to);
  return t;
}

module.exports = { DEFAULT_PRIVATE, pathMatches, privatePaths, isPrivatePath, parts, ruleMatches, deniedBy, allowedBy, cleanRules, redact, HIDDEN };
