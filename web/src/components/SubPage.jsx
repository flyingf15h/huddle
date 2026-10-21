// A page made of tabs (Studio, Settings): a row of mono tabs with a > on the current one, then that tab's view.
export default function SubPage({ tabs, tab, onPick, label, children }) {
  return (
    <div className="subpage">
      <nav className="subtabs" role="tablist" aria-label={label}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => onPick(k)}>{l}</button>)}
      </nav>
      {children}
    </div>
  );
}
