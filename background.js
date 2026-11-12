import {createEngine, alarmName, UserError} from './engine.js';
const engine = createEngine(chrome);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === alarmName) engine.runAutomatic().catch(engine.recordError);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  engine.request(message).then(result => respond({ok: true, result}), error => respond({ok: false, error: error instanceof UserError ? error.message : 'Operation failed. Cleanup may be incomplete. Preview again.'}));
  return true;
});
engine.initialize().catch(engine.recordError);
