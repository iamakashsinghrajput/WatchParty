// WatchParty content script: injects the sidebar iframe and a toggle handle,
// shifts the page over so the sidebar takes a real right-side column, and
// bridges the page's <video> element to the sidebar for playback sync.
(() => {
  if (window.top !== window) return;
  if (window.__watchpartyLoaded) return;
  window.__watchpartyLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  // Sites where the sidebar opens automatically (streaming/video sites).
  const AUTO_OPEN_HOSTS =
    /(^|\.)((netflix|youtube|primevideo|disneyplus|hotstar|hulu|max)\.com|youtu\.be)$/;
  const isAmazonVideo =
    /(^|\.)amazon\./.test(location.hostname) &&
    /video/i.test(location.pathname + location.search);

  let frame = null;
  let isOpen = false;

  const btn = document.createElement("button");
  btn.id = "watchparty-toggle";
  btn.type = "button";
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#e23b4a" d="M5 2.5h14A4.5 4.5 0 0 1 23.5 7v7a4.5 4.5 0 0 1-4.5 4.5h-6.6l-4.8 3.9A.9.9 0 0 1 6.1 21.7V18.4A4.5 4.5 0 0 1 .5 14V7A4.5 4.5 0 0 1 5 2.5Z"/>' +
    '<path fill="#fff" d="M10 7.4v6.2a.8.8 0 0 0 1.2.68l5.3-3.1a.8.8 0 0 0 0-1.37l-5.3-3.1a.8.8 0 0 0-1.2.69Z"/></svg>';
  btn.title = "WatchParty — watch together with camera & chat";
  btn.setAttribute("aria-label", "Toggle WatchParty sidebar");
  btn.addEventListener("click", () => setOpen(!isOpen));

  function ensureFrame() {
    if (frame && frame.isConnected) return frame;
    frame = document.createElement("iframe");
    frame.id = "watchparty-frame";
    frame.src = api.runtime.getURL("sidebar/sidebar.html");
    // Camera/mic permission is scoped to the extension origin, so one grant
    // covers every site the sidebar is opened on.
    frame.setAttribute("allow", "camera; microphone; autoplay; clipboard-write");
    document.documentElement.appendChild(frame);
    return frame;
  }

  function setOpen(v) {
    isOpen = v;
    if (v) ensureFrame();
    if (frame) {
      frame.classList.toggle("wp-open", v);
      post({ action: "visibility", open: v });
    }
    btn.classList.toggle("wp-shifted", v);
    document.documentElement.classList.toggle("watchparty-push", v);
    // Nudge responsive players (YouTube etc.) to reflow into the new width.
    window.dispatchEvent(new Event("resize"));
    try {
      sessionStorage.setItem("watchparty-open", v ? "1" : "0");
    } catch {}
  }

  function post(msg) {
    frame?.contentWindow?.postMessage({ source: "watchparty-host", ...msg }, "*");
  }

  /* --------------------------- playback sync bridge --------------------------- */

  let video = null;
  let suppressUntil = 0; // ignore events we caused ourselves for a moment

  const onPlay = () => report("play");
  const onPause = () => report("pause");
  const onSeeked = () => report("seek");

  function report(kind) {
    if (!video || Date.now() < suppressUntil) return;
    post({ action: "video-event", kind, time: video.currentTime || 0 });
  }

  function bindVideo(v) {
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

  // The page's main video: the largest one that is actually rendered.
  function pickVideo() {
    const vids = [...document.querySelectorAll("video")].filter(
      (v) => v.offsetWidth > 0 && v.offsetHeight > 0
    );
    vids.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    bindVideo(vids[0] || null);
    return video;
  }

  function applyControl(cmd, time) {
    const v = pickVideo();
    if (!v) return;
    suppressUntil = Date.now() + 900;
    if (cmd === "play") {
      if (typeof time === "number" && Math.abs(v.currentTime - time) > 1.5) v.currentTime = time;
      v.play().catch(() => {});
    } else if (cmd === "pause") {
      v.pause();
      if (typeof time === "number" && Math.abs(v.currentTime - time) > 1.5) v.currentTime = time;
    } else if (cmd === "seek" && typeof time === "number") {
      v.currentTime = time;
    }
  }

  // SPA sites swap their <video> without navigation — re-pick periodically.
  setInterval(() => {
    if (isOpen && video && !video.isConnected) pickVideo();
  }, 5000);

  /* -------------------------------- messaging -------------------------------- */

  api.runtime?.onMessage?.addListener((msg) => {
    if (msg && msg.source === "watchparty" && msg.action === "toggle") {
      setOpen(!isOpen);
    }
  });

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "watchparty") return;
    if (frame && e.source !== frame.contentWindow) return;
    if (d.action === "close") {
      setOpen(false);
    } else if (d.action === "video-query") {
      const v = pickVideo();
      post({
        action: "video-state",
        available: !!v,
        paused: v ? v.paused : true,
        time: v ? v.currentTime : 0,
      });
    } else if (d.action === "video-control") {
      applyControl(String(d.cmd || ""), d.time);
    }
  });

  let saved = null;
  try {
    saved = sessionStorage.getItem("watchparty-open");
  } catch {}
  const autoOpen = AUTO_OPEN_HOSTS.test(location.hostname) || isAmazonVideo;

  const start = () => {
    (document.body || document.documentElement).appendChild(btn);
    if (saved === "1" || (autoOpen && saved !== "0")) setOpen(true);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
