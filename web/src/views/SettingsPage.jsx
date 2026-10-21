// Settings: team and access, then usage and health (their own pages before), integrations, rules and the rest.
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import SubPage from '../components/SubPage.jsx';
import Settings, { TABS } from './Settings.jsx';
import Usage from './Usage.jsx';
import Health from './Health.jsx';

export default function SettingsPage() {
  useS();
  const tab = TABS.some(([k]) => k === S.settingsTab) ? S.settingsTab : 'team';
  return (
    <SubPage tabs={TABS} tab={tab} onPick={(k) => (S.settingsTab = k)} label="Settings">
      {tab === 'usage' ? <Usage /> : tab === 'health' ? <Health /> : <Settings tab={tab} />}
    </SubPage>
  );
}
