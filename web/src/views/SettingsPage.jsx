// Settings: team and access, integrations, rules, notifications, appearance, data and the audit log.
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import SubPage from '../components/SubPage.jsx';
import Settings, { TABS } from './Settings.jsx';

export default function SettingsPage() {
  useS();
  const tab = TABS.some(([k]) => k === S.settingsTab) ? S.settingsTab : 'team';
  return (
    <SubPage tabs={TABS} tab={tab} onPick={(k) => (S.settingsTab = k)} label="Settings">
      <Settings tab={tab} />
    </SubPage>
  );
}
