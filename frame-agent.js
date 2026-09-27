// WatchParty frame agent. Runs in EVERY http/https frame — including the
// cross-origin <iframe> players that many video sites (and embed-based sites)
// use, which the top-frame content script cannot reach into.
//
// Each agent finds the largest <video> in its own frame, reports its state and
// events up to the top frame, and applies play/pause/seek commands that flow
// down from the top frame (forwarding them into its own child frames too).
(() => {
  const p = location.protocol;
  if (p !== "http:" && p !== "https:") return; // never in the extension's own UI
  if (window.__wpAgent) return;
  window.__wpAgent = true;

  const TOP = window.top;
  let video = null;
  let suppressUntil = 0;

  const area = (v) => (v ? v.offsetWidth * v.offsetHeight : 0);

  function bestVideo() {
    const vids = [...document.querySelectorAll("video")].filter(
      (v) => v.offsetWidth > 8 && v.offsetHeight > 8
    );
    vids.sort((a, b) => area(b) - area(a));
    return vids[0] || null;
  }

  function toTop(msg) {
    try { TOP.postMessage(Object.assign({ __wpAgent: 1 }, msg), "*"); } catch {}
  }

  function report(kind) {
    if (!video || Date.now() < suppressUntil) return;
    toTop({ t: "event", kind, time: video.currentTime || 0, area: area(video) });
  }
  const onPlay = () => report("play");
  const onPause = () => report("pause");
  const onSeeked = () => report("seek");

  function bind(v) {
    if (video === v) return;
    if (video) {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
    }
    video = v;
    if (video) {
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("seeked", onSeeked);
    }
  }

  function sendState() {
    const v = bestVideo();
    bind(v);
    toTop({ t: "state", has: !!v, paused: v ? v.paused : true, time: v ? v.currentTime : 0, area: area(v) });
  }

  function forward(msg) {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(msg, "*"); } catch {}
    }
  }

  function apply(cmd, time) {
    const v = bestVideo();
    bind(v);
    if (v) {
      suppressUntil = Date.now() + 1500;
      if (cmd === "play") {
        if (typeof time === "number" && Math.abs(v.currentTime - time) > 1.5) {
          try { v.currentTime = time; } catch {}
        }
        v.play().catch(() => {});
      } else if (cmd === "pause") {
        v.pause();
        if (typeof time === "number" && Math.abs(v.currentTime - time) > 1.5) {
          try { v.currentTime = time; } catch {}
        }
      } else if (cmd === "seek" && typeof time === "number") {
        try { v.currentTime = time; } catch {}
      }
    }
    forward({ __wpCtrl: 1, cmd, time }); // let nested frames handle it too
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;
    if (d.__wpCtrl) apply(String(d.cmd || ""), d.time);
    else if (d.__wpQuery) { sendState(); forward({ __wpQuery: 1 }); }
  });

  // Report on load and periodically, so late-loading players are picked up.
  setInterval(sendState, 3000);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendState);
  }
  sendState();
})();
