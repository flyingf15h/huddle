// What never leaves a computer: private files by default, secrets stripped from shared text,
// and the install pages.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const policy = require('../src/policy');
const { privateFiles } = require('../src/doctor');

for (const f of ['.env', 'app/.env.production', 'deploy/id_rsa', 'a/b/server.pem', '.aws/credentials', 'infra/prod.tfvars', 'creds/service-account-prod.json', 'ios/GoogleService-Info.plist', 'terraform.tfstate'])
  assert(policy.isPrivatePath(undefined, f), `${f} should be private by default`);
for (const f of ['src/index.js', 'README.md', 'package.json', 'environment.md'])
  assert(!policy.isPrivatePath(undefined, f), `${f} should be shared`);

const secrets = [
  'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'whsec_' + 'a1B2c3D4e5F6g7H8i9J0', 'ghp_' + 'a'.repeat(36),
  'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwx1234', 'DB_PASSWORD=hunter2hunter2', 'postgres://admin:s3cretpass@db.example.com/app',
  'AccountKey=' + 'Zm9vYmFyYmF6cXV4', 'sk-ant-' + 'x'.repeat(30), 'glpat-' + 'a1B2c3D4e5F6g7H8i9J0',
];
for (const s of secrets) {
  const out = policy.redact(`here: ${s} done`);
  assert(out.includes(policy.HIDDEN), `not redacted: ${s} -> ${out}`);
  assert(!out.includes(s.split(/[=: ]/).pop()) || s.startsWith('postgres'), `leaked: ${out}`);
}
assert.equal(policy.redact('process.env.API_KEY and $TOKEN are fine'), 'process.env.API_KEY and $TOKEN are fine');
assert.equal(policy.redact('see src/token.js for the tokens table'), 'see src/token.js for the tokens table');

// doctor finds the private files in a folder
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'huddle-priv-'));
fs.mkdirSync(path.join(dir, 'app'));
fs.writeFileSync(path.join(dir, '.env'), 'A=1');
fs.writeFileSync(path.join(dir, 'app', 'key.pem'), 'x');
fs.writeFileSync(path.join(dir, 'app', 'main.js'), 'x');
assert.deepEqual(privateFiles(dir).sort(), ['.env', 'app/key.pem']);
fs.rmSync(dir, { recursive: true, force: true });

// the one-line installers are valid and carry both ways in
const sh = fs.readFileSync(path.join(__dirname, '..', 'public', 'install.sh'), 'utf8');
assert(/join "\$@"/.test(sh) && /huddle new|\$HUDDLE new/.test(sh));
assert(fs.existsSync(path.join(__dirname, '..', 'public', 'install.ps1')) && fs.existsSync(path.join(__dirname, '..', 'public', 'j.html')));
console.log('privacy: all good');
