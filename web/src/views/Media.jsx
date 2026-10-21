// Test, a Studio tab: playable builds to try first (there are only ever a few), then the images.
import Builds from './Builds.jsx';
import Gallery from './Gallery.jsx';

export default function Media() {
  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview">
        <h2 className="sechead">builds</h2>
        <Builds bare />
        <h2 className="sechead">images</h2>
        <Gallery bare />
      </div>
    </main>
  );
}
