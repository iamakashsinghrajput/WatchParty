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
  // Chrome/Brave side panel available: the browser shrinks the whole page for
  // us and the panel survives navigations. The in-page frame is the fallback.
  let panelMode = false;
  let panelLinked = false; // the side panel has talked to this page

  const btn = document.createElement("button");
  btn.id = "watchparty-toggle";
  btn.type = "button";
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#e23b4a" d="M5 2.5h14A4.5 4.5 0 0 1 23.5 7v7a4.5 4.5 0 0 1-4.5 4.5h-6.6l-4.8 3.9A.9.9 0 0 1 6.1 21.7V18.4A4.5 4.5 0 0 1 .5 14V7A4.5 4.5 0 0 1 5 2.5Z"/>' +
    '<path fill="#fff" d="M10 7.4v6.2a.8.8 0 0 0 1.2.68l5.3-3.1a.8.8 0 0 0 0-1.37l-5.3-3.1a.8.8 0 0 0-1.2.69Z"/></svg>';
  btn.title = "WatchParty — watch together with camera & chat";
  btn.setAttribute("aria-label", "Toggle WatchParty sidebar");
  btn.addEventListener("click", () => {
    if (!panelMode) return setOpen(!isOpen);
    api.runtime.sendMessage({ source: "watchparty", action: "open-panel" })
      .then((r) => { if (!r || !r.ok) setOpen(!isOpen); })
      .catch(() => setOpen(!isOpen));
  });

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

  const PANEL_W = 340;

  // Full-width position:fixed elements (Netflix/Prime/Hotstar players, YouTube's
  // masthead, …) are sized against the viewport, not <html>, so the CSS width
  // cut misses them. Pin each one's right edge to the panel. Only ancestors of
  // <video>s and shallow page chrome are checked, so this stays cheap on huge
  // DOMs. Original inline values are kept so closing restores them exactly.
  const FIT_PROPS = ["left", "right", "width", "max-width", "min-width"];
  const fitted = new Map(); // el -> {prop: [value, priority]}

  function fitCandidates() {
    const set = new Set();
    for (const v of document.querySelectorAll("video")) {
      for (let el = v; el && el !== document.body && el !== document.documentElement; el = el.parentElement) set.add(el);
    }
    if (document.body) {
      for (const el of document.body.querySelectorAll(":scope > *, :scope > * > *, :scope > * > * > *")) set.add(el);
    }
    return set;
  }

  function fitFixed() {
    if (!isOpen) return;
    const vw = window.innerWidth;
    for (const el of fitted.keys()) if (!el.isConnected) fitted.delete(el);
    for (const el of fitCandidates()) {
      if (el === frame || el === btn || fitted.has(el)) continue;
      if (getComputedStyle(el).position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      // Wide, anchored at the left edge, and running under the panel.
      if (r.left > 1 || r.width < vw * 0.5 || r.right <= vw - PANEL_W + 1) continue;
      const orig = {};
      for (const p of FIT_PROPS) orig[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
      fitted.set(el, orig);
      el.style.setProperty("left", "0px", "important");
      el.style.setProperty("right", PANEL_W + "px", "important");
      el.style.setProperty("width", "auto", "important");
      el.style.setProperty("min-width", "0px", "important");
      el.style.setProperty("max-width", `calc(100vw - ${PANEL_W}px)`, "important");
    }
  }

  function unfitFixed() {
    for (const [el, orig] of fitted) {
      for (const p of FIT_PROPS) {
        const [val, prio] = orig[p];
        if (val) el.style.setProperty(p, val, prio);
        else el.style.removeProperty(p);
      }
    }
    fitted.clear();
  }

  // Players are built (and rebuilt) dynamically — refit as the DOM changes.
  let fitTimer = 0;
  const scheduleFit = () => {
    if (!isOpen || fitTimer) return;
    fitTimer = setTimeout(() => { fitTimer = 0; fitFixed(); }, 300);
  };
  const fitObserver = new MutationObserver(scheduleFit);

  function setOpen(v) {
    isOpen = v;
    if (v) ensureFrame();
    if (frame) {
      frame.classList.toggle("wp-open", v);
      post({ action: "visibility", open: v });
    }
    btn.classList.toggle("wp-shifted", v);
    document.documentElement.classList.toggle("watchparty-push", v);
    if (v) {
      fitFixed();
      fitObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      fitObserver.disconnect();
      unfitFixed();
    }
    // Nudge responsive players (YouTube etc.) to reflow into the new width.
    window.dispatchEvent(new Event("resize"));
    try {
      sessionStorage.setItem("watchparty-open", v ? "1" : "0");
    } catch {}
  }

  // Elements that become full-width on resize (e.g. a window going wide) need
  // fitting too. Already-fitted ones use viewport-relative values, so they
  // follow resizes on their own.
  window.addEventListener("resize", scheduleFit);

  function post(msg) {
    frame?.contentWindow?.postMessage({ source: "watchparty-host", ...msg }, "*");
    if (panelLinked) {
      try { api.runtime.sendMessage({ source: "watchparty-host", ...msg }).catch(() => {}); } catch {}
    }
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
      ad: a ? !!a.ad : false,
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

  api.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== "watchparty") return;
    if (msg.action === "toggle") setOpen(!isOpen);
    else if (msg.action === "ping") sendResponse(true);
    else if (msg.viaPanel) {
      panelLinked = true;
      onSidebarMessage(msg, true);
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
          area: Number(d.area) || 0, ad: !!d.ad, at: Date.now(),
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
    if (!frame || e.source !== frame.contentWindow) return;
    onSidebarMessage(d, false);
  });

  // Commands from the sidebar — the in-page frame or the browser side panel.
  // The panel outlives navigations, so it needs no rejoin handoff.
  function onSidebarMessage(d, viaPanel) {
    if (d.action === "close") {
      if (viaPanel) return;
      setOpen(false);
    } else if (d.action === "video-query") {
      broadcastQuery();
      relayState(); // answer immediately with what we already know
    } else if (d.action === "video-control") {
      applyControl(String(d.cmd || ""), d.time);
    } else if (d.action === "persist-rejoin") {
      if (viaPanel) return;
      // Keep a one-shot rejoin ready so this room survives a navigation.
      try {
        sessionStorage.setItem("watchparty-rejoin", JSON.stringify({
          code: String(d.code || ""),
          role: d.role === "host" ? "host" : "guest",
          at: Date.now(),
        }));
      } catch {}
    } else if (d.action === "navigate") {
      const url = String(d.url || "");
      if (url && url !== location.href) {
        if (viaPanel) { location.assign(url); return; }
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
  }

  let saved = null;
  try {
    saved = sessionStorage.getItem("watchparty-open");
  } catch {}
  const autoOpen = AUTO_OPEN_HOSTS.test(location.hostname) || isAmazonVideo;
  const rejoining = !!readRejoin();

  const start = async () => {
    // Attach to <html>, not <body>, so the page's own layout never moves it.
    document.documentElement.appendChild(btn);
    try {
      const r = await api.runtime.sendMessage({ source: "watchparty", action: "panel-supported" });
      panelMode = !!(r && r.ok);
    } catch {}
    if (panelMode) {
      // Tell an already-open side panel this page (re)loaded, so it re-reads
      // the video right away — e.g. after following the host to a new video.
      panelLinked = true;
      broadcastQuery();
      post({ action: "page-ready", href: location.href });
      return;
    }
    // In-page frame: open on load only to finish a content-sync handoff, to
    // restore an explicitly-opened panel, or on the streaming sites that auto-open.
    if (rejoining || saved === "1" || (autoOpen && saved !== "0")) setOpen(true);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
