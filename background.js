const DEFAULT_STATE = { active: false, revision: 0 };
let busy = false, nextCapture = 0;
const pendingTabs = new Set();

async function getState() {
  const stored = await chrome.storage.local.get('pickerState');
  return { ...DEFAULT_STATE, ...(stored.pickerState || {}) };
}
async function setState(active) {
  const current = await getState();
  const state = { active, revision: current.revision + 1 };
  await chrome.storage.local.set({ pickerState: state });
  return state;
}

chrome.action.onClicked.addListener(async () => { await setState(!(await getState()).active); await syncAllTabs(); });
chrome.tabs.onActivated.addListener(async ({tabId}) => { if ((await getState()).active) syncTab(tabId); });
chrome.tabs.onCreated.addListener(async tab => { if (tab.id != null && (await getState()).active) syncTab(tab.id); });
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => { if (changeInfo.status === 'complete' && (await getState()).active) syncTab(tabId); });
chrome.tabs.onRemoved.addListener(tabId => pendingTabs.delete(tabId));

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === 'deactivateAll' && sender.tab) { setState(false).then(syncAllTabs); return; }
  if (m.type !== 'capture' || !sender.tab || sender.frameId !== 0) return;
  if (busy || Date.now() < nextCapture) { reply({ retry: Math.max(100, nextCapture - Date.now()) }); return; }
  busy = true;
  (async () => {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!tab.active) throw Error('Inactive tab');
    nextCapture = Date.now() + 600;
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!(await chrome.tabs.get(tab.id)).active) throw Error('Tab changed');
    return { data };
  })().then(reply, () => reply({ error: 'Capture unavailable' })).finally(() => { busy = false; });
  return true;
});

async function syncAllTabs() {
  const state = await getState();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(t => t.id != null).map(t => syncTab(t.id, state)));
}
async function syncTab(tabId, expectedState) {
  if (pendingTabs.has(tabId)) return;
  pendingTabs.add(tabId);
  let sentState = expectedState;
  try {
    const state = sentState = expectedState || await getState();
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(tabId, { type: 'setActive', active: state.active, revision: state.revision });
    if (!response || response.revision !== state.revision) {
      const latest = await getState();
      if (latest.revision !== state.revision) await chrome.tabs.sendMessage(tabId, { type: 'setActive', active: latest.active, revision: latest.revision });
    }
    await chrome.action.setTitle({ tabId, title: state.active ? 'Deactivate color picker' : 'Pick a color' });
  } catch { /* Restricted pages and closed tabs are skipped. */ }
  finally {
    pendingTabs.delete(tabId);
    const latest = await getState();
    if (sentState && latest.revision !== sentState.revision) syncTab(tabId, latest);
  }
}
