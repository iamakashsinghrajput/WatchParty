// Toolbar button toggles the sidebar in the active tab.
// `browser` = Firefox, `chrome` = Chromium family; both promise-based in MV3.
const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  Promise.resolve(
    api.tabs.sendMessage(tab.id, { source: "watchparty", action: "toggle" })
  ).catch(() => {
    // No content script here (chrome:// pages, web store, etc.) — nothing to do.
  });
});
