// WatchParty content script (top frame only): injects the sidebar iframe and a
// toggle handle, shifts the page over, and coordinates playback sync.
//
// Video detection/control lives in frame-agent.js, which runs in EVERY frame
// (including cross-origin embeds used by many video sites). This top-frame
// script relays state/events up from the agents to the sidebar, and control
// commands down to the agents. Netflix-style seeks also go through the
// page-world bridge (page-bridge.js).
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

  /* --------------------------- one-shot rejoin --------------------------- */
  // Set ONLY when auto-opening the host's video (content sync), and consumed
  // on the very next page load. This is a one-shot handoff, never a sticky
  // session — creating or leaving a room is never affected by it.
  const REJOIN_TTL = 60000;

  function readRejoin() {
    try {
      const r = JSON.parse(sessionStorage.getItem("watchparty-rejoin") || "null");
      if (r && r.code && Date.now() - (r.at || 0) < REJOIN_TTL) return r;
    } catch {}
    return null;
  }
  function clearRejoin() {
    try { sessionStorage.removeItem("watchparty-rejoin"); } catch {}
  }

  function ensureFrame() {
    if (frame && frame.isConnected) return frame;
    injectBridge();
    frame = document.createElement("iframe");
    frame.id = "watchparty-frame";
    let src = api.runtime.getURL("sidebar/sidebar.html");
    const r = readRejoin();
    if (r) {
      src += `?rejoin=${encodeURIComponent(r.code)}&role=${r.role === "host" ? "host" : "guest"}`;
      clearRejoin(); // one-shot: never rejoin again on later opens
    }
    frame.src = src;
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

  function injectBridge() {
    if (document.getElementById("watchparty-bridge-script")) return;
    const s = document.createElement("script");
    s.id = "watchparty-bridge-script";
    s.src = api.runtime.getURL("page-bridge.js");
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------ frame-agent coordination ----------------------- */
  // Each frame's agent reports the video it found and applies control commands.
  // We track them all and treat the largest video as the active one.

  const frames = new Map(); // WindowProxy -> {has, paused, time, area, at}

  function activeFrame() {
    let best = null;
    const now = Date.now();
    for (const [src, s] of frames) {
      if (now - s.at > 9000) { frames.delete(src); continue; }
      if (s.has && (!best || s.area > best.area)) best = s;
    }
    return best;
  }

  function relayState() {
    const a = activeFrame();
    post({
      action: "video-state",
      available: !!a,
      paused: a ? a.paused : true,
      time: a ? a.time : 0,
      // Content sync always navigates to the TOP page URL, not an embed's URL.
      href: location.href,
    });
  }

  // Broadcast a control/query into the frame tree. The top agent (same window)
  // applies it and forwards to child frames, which forward further down.
  function broadcastCtrl(cmd, time) {
    window.postMessage({ __wpCtrl: 1, cmd, time }, "*");
  }
  function broadcastQuery() {
    window.postMessage({ __wpQuery: 1 }, "*");
  }

  function seekTo(time) {
    if (typeof time !== "number") return;
    window.postMessage({ source: "watchparty-bridge", action: "seek", time }, "*");
  }

  function applyControl(cmd, time) {
    // Netflix and other top-frame DRM players seek only via their own API.
    if (cmd === "seek" && typeof time === "number") seekTo(time);
    // Every frame-agent (generic pages and cross-origin embeds) handles the rest.
    broadcastCtrl(cmd, time);
  }

  /* -------------------------------- messaging -------------------------------- */

  api.runtime?.onMessage?.addListener((msg) => {
    if (msg && msg.source === "watchparty" && msg.action === "toggle") {
      setOpen(!isOpen);
    }
  });

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;

    // Reports coming up from the frame-agents.
    if (d.__wpAgent) {
      if (d.t === "state") {
        frames.set(e.source, {
          has: !!d.has, paused: !!d.paused, time: Number(d.time) || 0,
          area: Number(d.area) || 0, at: Date.now(),
        });
        relayState();
      } else if (d.t === "event") {
        const s = frames.get(e.source);
        if (s) {
          s.time = Number(d.time) || 0; s.at = Date.now();
          if (d.kind === "play") s.paused = false;
          else if (d.kind === "pause") s.paused = true;
        }
        const a = activeFrame();
        // Only the active (largest) video's events drive the room.
        if (a && frames.get(e.source) === a) {
          post({ action: "video-event", kind: d.kind, time: Number(d.time) || 0 });
        }
      }
      return;
    }

    // Messages from the sidebar iframe.
    if (d.source !== "watchparty") return;
    if (frame && e.source !== frame.contentWindow) return;
    if (d.action === "close") {
      setOpen(false);
    } else if (d.action === "video-query") {
      broadcastQuery();
      relayState(); // answer immediately with what we already know
    } else if (d.action === "video-control") {
      applyControl(String(d.cmd || ""), d.time);
    } else if (d.action === "navigate") {
      const url = String(d.url || "");
      if (url && url !== location.href) {
        // One-shot handoff so the sidebar rejoins this room after the reload.
        try {
          sessionStorage.setItem("watchparty-rejoin", JSON.stringify({
            code: String(d.code || ""),
            role: d.role === "host" ? "host" : "guest",
            at: Date.now(),
          }));
          sessionStorage.setItem("watchparty-open", "1");
        } catch {}
        location.assign(url);
      }
    } else if (d.action === "clear-session") {
      clearRejoin();
    }
  });

  let saved = null;
  try {
    saved = sessionStorage.getItem("watchparty-open");
  } catch {}
  const autoOpen = AUTO_OPEN_HOSTS.test(location.hostname) || isAmazonVideo;
  const rejoining = !!readRejoin();

  const start = () => {
    (document.body || document.documentElement).appendChild(btn);
    // Open on load only to finish a content-sync handoff, to restore an
    // explicitly-opened panel, or on the streaming sites that auto-open.
    if (rejoining || saved === "1" || (autoOpen && saved !== "0")) setOpen(true);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
