const AUTO_ALARM = 'wallcheck-auto-recheck';
const AUTO_RECHECK_MINUTES = 10;
const ENDPOINT = 'http://127.0.0.1:17654/api/probe';

function ensureAutoAlarm() {
  chrome.alarms.get(AUTO_ALARM, alarm => {
    if (alarm && alarm.periodInMinutes === AUTO_RECHECK_MINUTES) return;
    chrome.alarms.clear(AUTO_ALARM, () => {
      chrome.alarms.create(AUTO_ALARM, {
        delayInMinutes: AUTO_RECHECK_MINUTES,
        periodInMinutes: AUTO_RECHECK_MINUTES
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureAutoAlarm);
chrome.runtime.onStartup.addListener(ensureAutoAlarm);
ensureAutoAlarm();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== AUTO_ALARM) return;
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {type:'auto-recheck'}, () => {
        void chrome.runtime.lastError;
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'probe') return;

  fetch(ENDPOINT, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(msg.payload)
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text);
    return JSON.parse(text);
  }).then(data => sendResponse({ok:true, data}))
    .catch(err => sendResponse({ok:false, error:String(err)}));
  return true;
});
