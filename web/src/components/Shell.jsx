// A view's outer frame: its own scrolling page, or (bare) just a section inside another page.
export default function Shell({ bare, children }) {
  if (bare) return <section className="baresec">{children}</section>;
  return <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}><div className="pageview">{children}</div></main>;
}
