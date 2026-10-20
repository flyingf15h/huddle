// Theme tiles, like Slack's: each shows its sidebar, page and accent. Used in the header menu and in
// Team & settings. "Match my computer" picks Cream or Evening from the system setting.
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { THEMES, resolveTheme, setThemePref, themePref } from '../lib/themes.js';

function Tile({ t, on, label, onPick }) {
  return (
    <button type="button" className={'ttile' + (on ? ' on' : '')} aria-pressed={on} onClick={onPick} title={label}>
      <span className="tprev" style={{ background: t.page }}>
        <span className="trail" style={{ background: t.rail }}><i style={{ background: t.railInk }} /><i style={{ background: t.railInk }} /><i style={{ background: t.railInk }} /></span>
        <span className="tbody"><i style={{ background: t.dark ? '#ffffff22' : '#00000014' }} /><i style={{ background: t.dark ? '#ffffff22' : '#00000014' }} /><b style={{ background: t.accent }} /></span>
      </span>
      <span className="tname">{label}</span>
    </button>
  );
}

export default function ThemePicker({ compact }) {
  useS();
  const pref = S.themePref || themePref();
  const pick = (p) => { setThemePref(p); S.themePref = p; };
  const light = THEMES.filter(t => !t.dark), dark = THEMES.filter(t => t.dark);
  return (
    <div className={'tpicker' + (compact ? ' compact' : '')}>
      <Tile t={resolveTheme('system')} on={pref === 'system'} label="Match my computer" onPick={() => pick('system')} />
      {!compact && <div className="tgroup">Light</div>}
      {light.map(t => <Tile key={t.id} t={t} on={pref === t.id} label={t.name} onPick={() => pick(t.id)} />)}
      {!compact && <div className="tgroup">Dark</div>}
      {dark.map(t => <Tile key={t.id} t={t} on={pref === t.id} label={t.name} onPick={() => pick(t.id)} />)}
    </div>
  );
}
