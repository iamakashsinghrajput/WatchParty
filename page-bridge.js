// WatchParty page-world bridge.
//
// Runs in the page's MAIN world (not the content script's isolated world), so
// it can reach player APIs that only live on the page's own `window` — most
// importantly Netflix's, which ignores `video.currentTime` and only seeks
// through its internal player. For every other site it falls back to setting
// `currentTime` on the largest visible <video>, which works fine.
(() => {
  if (window.__watchpartyBridge) return;
  window.__watchpartyBridge = true;

  function netflixPlayer() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      const sid = ids.find((i) => /watch/.test(i)) || ids[0];
      return sid ? api.getVideoPlayerBySessionId(sid) : null;
    } catch {
      return null;
    }
  }

  function mainVideo() {
    const vids = [...document.querySelectorAll("video")].filter((v) => v.offsetWidth > 0);
    vids.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    return vids[0] || null;
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "watchparty-bridge" || d.action !== "seek") return;
    const secs = Number(d.time) || 0;
    const np = netflixPlayer();
    if (np && typeof np.seek === "function") {
      try { np.seek(Math.round(secs * 1000)); return; } catch {}
    }
    const v = mainVideo();
    if (v) { try { v.currentTime = secs; } catch {} }
  });
})();
