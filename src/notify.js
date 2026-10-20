// Desktop notifications, so a person hears about messages and requests sent to their Claude right
// away instead of when they next type a prompt. Raised by the one session that runs this folder's
// request runner. The text comes from other people, so it reaches the OS notifier through the
// environment, never inside a script or a shell command line.
'use strict';
const { spawn } = require('child_process');

const SCRIPTS = {
  darwin: ['osascript', ['-e', 'display notification (system attribute "HUDDLE_NOTE_BODY") with title (system attribute "HUDDLE_NOTE_TITLE")']],
  linux: ['sh', ['-c', 'command -v notify-send >/dev/null && notify-send -a huddle "$HUDDLE_NOTE_TITLE" "$HUDDLE_NOTE_BODY"']],
  win32: ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; ' +
    '$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
    '$n.ShowBalloonTip(15000, $env:HUDDLE_NOTE_TITLE, $env:HUDDLE_NOTE_BODY, "Info"); Start-Sleep 15; $n.Dispose()']],
};

function notify(title, body) {
  const s = SCRIPTS[process.platform];
  if (!s) return;
  try {
    const child = spawn(s[0], s[1], {
      stdio: 'ignore', detached: true, windowsHide: true,
      env: { ...process.env, HUDDLE_NOTE_TITLE: String(title).slice(0, 120), HUDDLE_NOTE_BODY: String(body).replace(/\s+/g, ' ').slice(0, 400) },
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// What a live event means for this person, as a notification, or null if it isn't for them. A
// current server sends each person's notifications as "note" events (their own settings decide which
// reach the desktop); before the first one arrives, messages and requests are picked out directly.
let notesSeen = false;
function noteFor(ev, me) {
  if (ev.type === 'note') {
    notesSeen = true;
    if (ev.to !== me.name || !ev.note || !ev.note.desktop) return null;
    return { title: `huddle: ${ev.note.title}`, body: ev.note.body || '' };
  }
  if (notesSeen) return null;
  if (ev.type === 'message' && ev.message) {
    const m = ev.message;
    if (m.fromName === me.name || m.from === me.id) return null;
    if (m.to && m.to !== me.name && m.to !== me.id) return null;
    return { title: `huddle: ${m.fromName}${m.to ? ' → you' : ' → everyone'}`, body: m.text };
  }
  if (ev.type === 'board' && ev.action === 'goal' && ev.goal && ev.goal.to === me.name && ev.goal.byName !== me.name) {
    return { title: `huddle: request from ${ev.goal.byName} for your Claude`, body: ev.goal.text };
  }
  return null;
}

module.exports = { notify, noteFor };
