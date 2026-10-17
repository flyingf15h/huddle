// Shared project knowledge (PROJECT.md, memories, skills) on disk and in the
// agent's context. Nothing here is meant to be committed: files go under
// .huddle/ or into .claude/skills/ with a .git/info/exclude entry.
'use strict';
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, ago } = require('./client');

const DOC_IN_CONTEXT = 12 * 1024;

function sharedDir(root) { return path.join(root, CONFIG_DIR, 'shared'); }

function excludeFromGit(root, entry) {
  if (!fs.existsSync(path.join(root, '.git'))) return;
  const file = path.join(root, '.git', 'info', 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur.split('\n').includes(entry)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + entry + '\n');
}

function memoriesMarkdown(shared) {
  if (!shared.memories.length) return '# Shared memory\n\n(nothing yet)\n';
  return '# Shared memory\n\n' + shared.memories.map(m =>
    `## ${m.title}\n_${m.byName}, ${new Date(m.at).toISOString().slice(0, 10)} · id ${m.id}_\n\n${m.text}\n`).join('\n');
}

// Just the skills, for a parent folder linked to the project (huddle link)
function writeSkills(root, shared, log = () => {}) {
  const manifestFile = path.join(sharedDir(root), 'skills.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  const skillsRoot = path.join(root, '.claude', 'skills');
  const keep = [];
  for (const sk of shared.skills) {
    const skDir = path.join(skillsRoot, sk.name);
    if (fs.existsSync(skDir) && !manifest.includes(sk.name)) { log(`skill ${sk.name} exists already, skipped`); continue; }
    fs.mkdirSync(skDir, { recursive: true });
    writeIfChanged(path.join(skDir, 'SKILL.md'), sk.body);
    keep.push(sk.name);
  }
  for (const name of manifest) if (!keep.includes(name)) fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(keep));
}

// Write everything to disk. Skills we created are tracked in a manifest so we
// can remove them later without ever touching skills the project owns.
function writeShared(root, shared, log = () => {}) {
  const dir = sharedDir(root);
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, 'PROJECT.md'), shared.doc ? shared.doc.text : '');
  writeIfChanged(path.join(dir, 'MEMORY.md'), memoriesMarkdown(shared));
  const manifestFile = path.join(dir, 'skills.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  const skillsRoot = path.join(root, '.claude', 'skills');
  const keep = [];
  for (const sk of shared.skills) {
    const skDir = path.join(skillsRoot, sk.name);
    if (fs.existsSync(skDir) && !manifest.includes(sk.name)) {
      log(`shared skill "${sk.name}" not installed: .claude/skills/${sk.name} already exists and isn't from huddle`);
      continue;
    }
    fs.mkdirSync(skDir, { recursive: true });
    writeIfChanged(path.join(skDir, 'SKILL.md'), sk.body);
    excludeFromGit(root, `.claude/skills/${sk.name}/`);
    keep.push(sk.name);
  }
  for (const name of manifest) {
    if (!keep.includes(name)) fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  }
  fs.writeFileSync(manifestFile, JSON.stringify(keep));
}

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.writeFileSync(file, text);
}

// compact fingerprint of what an agent has already been told about
function signature(shared) {
  return {
    version: shared.version,
    doc: shared.doc ? shared.doc.version : 0,
    memories: Object.fromEntries(shared.memories.map(m => [m.id, m.at])),
    skills: Object.fromEntries(shared.skills.map(s => [s.name, s.version])),
  };
}

function briefing(shared) {
  const parts = [];
  if (shared.doc && shared.doc.text.trim()) {
    const t = shared.doc.text;
    parts.push(`Shared PROJECT.md (v${shared.doc.version}, last edited by ${shared.doc.byName}). Treat it like CLAUDE.md for this project; it is not in git, edit it with huddle_project:\n` +
      (t.length > DOC_IN_CONTEXT ? t.slice(0, DOC_IN_CONTEXT) + '\n[truncated; full text in .huddle/shared/PROJECT.md]' : t));
  } else {
    parts.push('The project has no shared PROJECT.md yet. If you learn the goals, conventions or architecture, write one with huddle_project so every agent starts with it.');
  }
  if (shared.memories.length) {
    const lines = shared.memories.slice(-60).map(m => `- ${m.title}: ${oneLine(m.text, 200)} (${m.byName})`);
    parts.push(`Shared memory from the team (full text in .huddle/shared/MEMORY.md, search with huddle_recall):\n${lines.join('\n')}`);
  }
  if (shared.skills.length) {
    parts.push('Shared skills (installed in .claude/skills/, use them like any skill):\n' +
      shared.skills.map(s => `- ${s.name}: ${oneLine(s.description, 160)}`).join('\n'));
  }
  return parts.join('\n\n');
}

// What changed since `seen` (a signature), phrased for the agent's context.
function describeChanges(seen, shared) {
  if (!seen) return '';
  const out = [];
  if (shared.doc && shared.doc.version > (seen.doc || 0)) {
    out.push(`${shared.doc.byName} updated the shared PROJECT.md (now v${shared.doc.version}). Re-read .huddle/shared/PROJECT.md if it affects your work.`);
  }
  for (const m of shared.memories) {
    const before = seen.memories && seen.memories[m.id];
    if (before === m.at) continue;
    out.push(`${before ? 'Updated' : 'New'} shared memory from ${m.byName}: ${m.title}: ${oneLine(m.text, 600)}`);
  }
  for (const id of Object.keys(seen.memories || {})) {
    if (!shared.memories.some(m => m.id === id)) out.push(`A shared memory (id ${id}) was deleted.`);
  }
  for (const s of shared.skills) {
    const before = seen.skills && seen.skills[s.name];
    if (before === s.version) continue;
    out.push(`${before ? 'Updated' : 'New'} shared skill "${s.name}" from ${s.byName}: ${oneLine(s.description, 200)}`);
  }
  for (const name of Object.keys(seen.skills || {})) {
    if (!shared.skills.some(s => s.name === name)) out.push(`Shared skill "${name}" was removed.`);
  }
  return out.length ? 'Team knowledge changed:\n' + out.map(l => '- ' + l).join('\n') : '';
}

function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

module.exports = { writeSkills, writeShared, signature, briefing, describeChanges, memoriesMarkdown, sharedDir, ago };
