// Toolbar button toggles the sidebar in the active tab.
// `browser` = Firefox, `chrome` = Chromium family; both promise-based in MV3.
const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await api.tabs.sendMessage(tab.id, { source: "watchparty", action: "toggle" });
  } catch {
    // No content script here — this page is outside the declared streaming
    // sites. The user's click grants activeTab, so inject the sidebar now.
    try {
      await api.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      // Also drop the frame agent into every frame, so videos inside embedded
      // (often cross-origin) players are found and controllable.
      await api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["frame-agent.js"],
      });
      await api.tabs.sendMessage(tab.id, { source: "watchparty", action: "toggle" });
    } catch {
      // chrome:// pages, the Web Store, etc. — nothing to do.
    }
  }
});
