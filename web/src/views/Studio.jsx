// Studio, where you manage the project: the shared brief and memory, the timeline, builds and images, usage, health and GitHub.
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import SubPage from '../components/SubPage.jsx';
import Brief from './Brief.jsx';
import Timeline from './Timeline.jsx';
import Media from './Media.jsx';
import GitHub from './GitHub.jsx';
import Usage from './Usage.jsx';
import Health from './Health.jsx';

const TABS = [['brief', 'brief'], ['timeline', 'timeline'], ['gallery', 'gallery'], ['usage', 'usage'], ['health', 'health'], ['github', 'github']];

export default function Studio() {
  useS();
  const tab = TABS.some(([k]) => k === S.studioTab) ? S.studioTab : 'brief';
  return (
    <SubPage tabs={TABS} tab={tab} onPick={(k) => (S.studioTab = k)} label="Studio">
      {tab === 'timeline' ? <Timeline /> : tab === 'gallery' ? <Media /> : tab === 'usage' ? <Usage /> : tab === 'health' ? <Health /> : tab === 'github' ? <GitHub /> : <Brief />}
    </SubPage>
  );
}
