// Unity and Blender: turn an editor on for the team, and the one-time setup each person does in it.
// (Same steps as src/apps.js; that file registers the MCP servers in each teammate's folder.)
import { useState } from 'react';
import { S, api, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';

const EDITORS = [
  ['unity', 'Unity', 'Agents build scenes, prefabs and scripts through MCP for Unity, or Unity\'s own MCP in Unity 6.', [
    <>Install <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noopener noreferrer">uv</a>.</>,
    <>In Unity, open Window → Package Manager → + → Add package from git URL, and paste <code>https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main</code></>,
    <>Open Window → MCP for Unity, choose stdio under Settings, and click Start Bridge.</>,
  ]],
  ['blender', 'Blender', 'Agents model, texture and arrange scenes through MCP for Blender.', [
    <>Install <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noopener noreferrer">uv</a>, then run <code>uvx mcp-for-blender install-addon</code></>,
    <>In Blender, open Edit → Preferences → Add-ons and turn on MCP for Blender.</>,
    <>In the 3D viewport press N, open the MCP for Blender tab and click Start MCP Server.</>,
  ]],
];

export default function Editors() {
  useS();
  const owner = isOwner();
  const on = (S.projectSettings || {}).apps || [];
  const [open, setOpen] = useState(null), [msg, setMsg] = useState(null);
  const set = async (id, want) => {
    setMsg(null);
    try {
      const r = await api('project-setting', { apps: want ? [...new Set([...on, id])] : on.filter(x => x !== id) });
      S.projectSettings = { ...S.projectSettings, apps: r.settings.apps || [] };
      if (want) setOpen(id);
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="panel"><h3>Unity and Blender</h3>
      <p className="pdesc">Let the team's agents work inside the editor, not just on code. Each teammate's agent gets the editor's tools at its next session. Scenes, prefabs and .blend files changed through the editor are locked like any other edit, so two people never end up with two versions of a scene that can't be merged.</p>
      {EDITORS.map(([id, label, sub, steps], i) => (
        <div key={id}>
          <div className="switchrow" style={i ? undefined : { borderTop: 0 }}><span className="grow"><b>{label}</b><span>{sub}</span></span>
            {on.includes(id) && <button className="link small" onClick={() => setOpen(open === id ? null : id)}>{open === id ? 'Hide setup' : 'Setup'}</button>}
            <button className="toggle" role="switch" aria-checked={on.includes(id)} aria-label={label} disabled={!owner} onClick={() => set(id, !on.includes(id))}></button></div>
          {open === id && on.includes(id) && (
            <div className="pbody" style={{ padding: '0 16px 12px' }}><p className="hintline" style={{ marginTop: 0 }}>Once on each computer, then restart the agent:</p>
              <ol className="steps">{steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
              <p className="hintline"><code>huddle doctor</code> checks it from the project folder. Background agents don't get editor tools, because the editor has the person's own folder open.</p></div>
          )}
        </div>
      ))}
      {!owner && <p className="readonly-note">Only the project owner can turn editors on or off.</p>}
      {msg && <p className="small err" style={{ padding: '0 16px 12px' }}>{msg}</p>}
    </div>
  );
}
