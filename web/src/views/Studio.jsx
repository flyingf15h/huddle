// Studio: the shared brief and memory, the timeline, the gallery and builds, as tabs of one page.
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import SubPage from '../components/SubPage.jsx';
import Brief from './Brief.jsx';
import Timeline from './Timeline.jsx';
import Gallery from './Gallery.jsx';
import Builds from './Builds.jsx';

const TABS = [['brief', 'brief'], ['timeline', 'timeline'], ['gallery', 'gallery'], ['builds', 'builds']];

export default function Studio() {
  useS();
  const tab = TABS.some(([k]) => k === S.studioTab) ? S.studioTab : 'brief';
  return (
    <SubPage tabs={TABS} tab={tab} onPick={(k) => (S.studioTab = k)} label="Studio">
      {tab === 'timeline' ? <Timeline /> : tab === 'gallery' ? <Gallery /> : tab === 'builds' ? <Builds /> : <Brief />}
    </SubPage>
  );
}
