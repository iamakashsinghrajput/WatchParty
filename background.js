// Toolbar button opens WatchParty. Where the browser has a side panel
// (Chrome, Brave, Edge) it opens there — the browser shrinks the whole page
// beside it and the panel survives page navigations, so calls never drop on a
// video change. Elsewhere it toggles the in-page sidebar.
// `browser` = Firefox, `chrome` = Chromium family; both promise-based in MV3.
const api = globalThis.browser ?? globalThis.chrome;
const hasPanel = !!api.sidePanel?.open;

if (hasPanel) {
  // We open it ourselves (so the page scripts get injected too).
  api.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
}

// Make sure the page has our content script + frame agents. On the declared
// streaming sites they're already there; elsewhere the toolbar click granted
// activeTab, so inject now.
async function ensureInjected(tabId) {
  try {
    await api.tabs.sendMessage(tabId, { source: "watchparty", action: "ping" });
    return true;
  } catch {}
  try {
    await api.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    // Also drop the frame agent into every frame, so videos inside embedded
    // (often cross-origin) players are found and controllable.
    await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["frame-agent.js"] });
    return true;
  } catch {
    return false; // chrome:// pages, the Web Store, etc.
  }
}

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (hasPanel) {
    // Must be called straight from the click (user gesture) — before any await.
    const opening = api.sidePanel.open({ windowId: tab.windowId });
    await ensureInjected(tab.id);
    try {
      await opening;
      return;
    } catch {} // fall through to the in-page sidebar
  }
  if (await ensureInjected(tab.id)) {
    try { await api.tabs.sendMessage(tab.id, { source: "watchparty", action: "toggle" }); } catch {}
  }
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "watchparty") return;
  if (msg.action === "panel-supported") {
    sendResponse({ ok: hasPanel });
  } else if (msg.action === "open-panel") {
    // From the page's WatchParty handle (a click, so the gesture carries).
    if (!hasPanel || !sender.tab) return sendResponse({ ok: false });
    api.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
});
