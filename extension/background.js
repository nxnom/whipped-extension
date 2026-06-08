// Background service worker. With no default_popup, clicking the toolbar icon
// fires this — it tells the active tab's content script to enter select mode.

const ICONS = {
  active: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
  inactive: { 16: "icons/gray-16.png", 48: "icons/gray-48.png", 128: "icons/gray-128.png" },
};

// Content scripts report when they enter/leave select mode so the toolbar icon
// shows the colored logo while active and falls back to grayscale otherwise.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "WHIPPED_SET_ACTIVE" || !sender.tab?.id) return;
  chrome.action.setIcon({ tabId: sender.tab.id, path: msg.active ? ICONS.active : ICONS.inactive });
});

// A per-tab icon override survives navigation, so a tab left active would keep the
// colored icon after a reload. Revert to grayscale when the tab starts loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setIcon({ tabId, path: ICONS.inactive }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const start = () => chrome.tabs.sendMessage(tab.id, { type: "START_ANNOTATING" });

  try {
    await start();
  } catch {
    // Content script not present yet (page loaded before install/update). Inject
    // the MAIN-world fiber bridge + the content script, then retry. Fails silently
    // on restricted pages (chrome://, the extension gallery, etc.).
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-main.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await start();
    } catch {
      // Nothing we can do on a restricted page.
    }
  }
});
