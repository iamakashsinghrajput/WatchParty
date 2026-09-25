// WatchParty sidebar app. Runs as an extension page inside the injected iframe,
// standalone over http for development/testing, and as a popped-out window.
//
// URL params (used by tests and as escape hatches):
//   ?fake=1          use a generated avatar stream instead of the camera
//   ?name=X          preset display name
//   ?create=1        auto-create a room on load
//   ?join=CODE       auto-join a room on load
//   ?host=..&port=.. use a self-hosted PeerServer instead of the PeerJS cloud
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FAKE = params.get("fake") === "1";
const FRAMED = window.parent !== window;
const MAX_PARTICIPANTS = 6; // mesh video stays usable up to ~6 people

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* --------------------------------- profile --------------------------------- */

const AVATARS = ["🍿", "🎬", "🎧", "🌙", "⭐", "🔥", "🐯", "🐼", "🦊", "🐸", "🐙", "🦄", "🍕", "🍩", "⚡", "🎮"];
const AVATAR_BGS = ["#f6d96b", "#f2a3b3", "#a3d9f2", "#b8f2a3", "#e3b8f2", "#f2cba3", "#a3f2e0", "#dcdcdc"];
const NAME_COLORS = ["", "#e05252", "#e08a2c", "#e0d048", "#7bd94e", "#4ed9c7", "#a06ae8", "#e06ab8"];
const BADGES = ["", "💎", "👑", "⭐", "💗", "🏅"];
const REACTIONS = ["🥰", "😡", "😭", "😂", "🤯", "🔥"];
const EMOJIS = ["😀", "😂", "😍", "😎", "🤔", "😱", "😴", "🥳", "👍", "👎", "👏", "🙌", "❤️", "💔", "🔥", "✨", "🍿", "🎬", "🎉", "😭", "🤯", "🫠", "💀", "🙈"];

const avatarBg = (emoji) =>
  AVATAR_BGS[[...String(emoji || "🍿")].reduce((a, c) => a + c.codePointAt(0), 0) % AVATAR_BGS.length];

function loadProfile() {
  let p = null;
  try { p = JSON.parse(store.get("wp-profile") || "null"); } catch {}
  const name = (params.get("name") || p?.name || store.get("wp-name") || "").trim().slice(0, 20);
  return {
    name,
    color: NAME_COLORS.includes(p?.color) ? p.color : "",
    avatar: AVATARS.includes(p?.avatar) ? p.avatar : "🍿",
    badge: BADGES.includes(p?.badge) ? p.badge : "",
  };
}

const profile = loadProfile();

function saveProfile() {
  store.set("wp-profile", JSON.stringify(profile));
  store.set("wp-name", profile.name);
}

function profileMsg(type, extra) {
  return Object.assign({
    type,
    name: profile.name,
    color: profile.color,
    avatar: profile.avatar,
    badge: profile.badge,
  }, extra);
}

/* ---------------------------------- state ---------------------------------- */

const state = {
  peer: null,
  peers: new Map(),     // peerId -> {id, profile, conn, call, tile, video, tag, announced}
  stream: null,         // local MediaStream — always has 1 video + 1 audio track
  videoIsFake: false,
  audioIsFake: false,
  camOn: false,
  micOn: false,
  role: null,           // "host" | "guest"
  room: null,
  pageVideo: false,     // the page under the sidebar has a <video> to sync
  canControl: false,    // guest: the host handed us the remote
  allowed: new Set(),   // host: peer ids allowed to control playback
  lastVideo: null,      // {paused, time, at} last known local page-video state
  pendingTick: null,    // host position report awaiting local comparison
  view: "lobby",        // "lobby" | "room" | "profile"
  viewBefore: "lobby",
};

/* ---------------------------------- media ---------------------------------- */

function makeCanvasTrack(label) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  let t = 0;
  setInterval(() => {
    t += 1;
    const wave = Math.sin(t / 40);
    const g = ctx.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, `hsl(${352 + wave * 6} 38% ${15 + wave * 2}%)`);
    g.addColorStop(1, `hsl(${222 + wave * 8} 30% 10%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 360);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.beginPath();
    ctx.arc(320, 152, 62, 0, Math.PI * 2);
    ctx.fillStyle = avatarBg(profile.avatar);
    ctx.fill();
    ctx.font = "58px system-ui, sans-serif";
    ctx.fillText(profile.avatar || "🍿", 320, 158);
    ctx.font = "500 19px system-ui, sans-serif";
    ctx.fillStyle = "rgba(244,243,242,.6)";
    ctx.fillText(label ? `${label} · camera off` : "camera off", 320, 258);
  }, 250);
  return canvas.captureStream(8).getVideoTracks()[0];
}

// A real (but silent) audio track. Because every call starts with both a video
// and an audio sender, enabling the camera or mic later is a plain
// replaceTrack() — no renegotiation, no re-joining.
function makeSilentTrack() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const dst = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(dst);
  osc.start();
  document.addEventListener("click", () => ctx.resume().catch(() => {}), { once: true });
  return dst.stream.getAudioTracks()[0];
}

function cameraNote(err) {
  const n = err?.name || "";
  if (n === "NotAllowedError")
    return "Camera blocked — showing an avatar instead. Use the camera button to retry after allowing access.";
  if (n === "NotFoundError") return "No camera found — showing an avatar instead.";
  if (n === "NotReadableError") return "Camera is busy in another app — showing an avatar instead.";
  return "Camera unavailable — showing an avatar instead.";
}

function savedDevices() {
  try { return JSON.parse(store.get("wp-devices") || "null") || {}; } catch { return {}; }
}

function videoConstraints() {
  const d = savedDevices();
  const c = { width: { ideal: 640 }, height: { ideal: 480 } };
  if (d.video) c.deviceId = { ideal: d.video };
  return c;
}

function audioConstraints() {
  const d = savedDevices();
  const c = { echoCancellation: true, noiseSuppression: true };
  if (d.audio) c.deviceId = { ideal: d.audio };
  return c;
}

async function ensureStream() {
  if (state.stream) return state.stream;
  let vTrack = null;
  let aTrack = null;
  if (!FAKE && navigator.mediaDevices?.getUserMedia) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(),
        audio: audioConstraints(),
      });
      vTrack = s.getVideoTracks()[0] || null;
      aTrack = s.getAudioTracks()[0] || null;
      setNote("");
    } catch (err) {
      // Retry each device on its own — one being blocked shouldn't cost the other.
      try {
        const sv = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
        vTrack = sv.getVideoTracks()[0] || null;
      } catch (e2) { setNote(cameraNote(e2)); }
      try {
        const sa = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
        aTrack = sa.getAudioTracks()[0] || null;
      } catch {}
    }
  }
  state.videoIsFake = !vTrack;
  state.audioIsFake = !aTrack;
  if (!vTrack) vTrack = makeCanvasTrack(profile.name || "");
  if (!aTrack) {
    aTrack = makeSilentTrack();
    aTrack.enabled = false; // starts muted; the mic button turns it on
  }
  state.camOn = !state.videoIsFake;
  state.micOn = !state.audioIsFake;
  state.stream = new MediaStream([vTrack, aTrack]);
  attachLocal();
  updateControls();
  return state.stream;
}

function attachLocal() {
  const mirror = !state.videoIsFake; // mirror only a real camera, not the avatar
  for (const id of ["previewVideo", "localVideo"]) {
    const el = $(id);
    if (el) {
      el.srcObject = state.stream;
      el.classList.toggle("mirror", mirror);
    }
  }
}

function stopPreview() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

// Swap a track on every active call at once — no renegotiation needed because
// the sender for that kind already exists.
function replaceTrackEverywhere(kind, track) {
  for (const e of state.peers.values()) {
    const senders = e.call?.peerConnection?.getSenders?.() || [];
    const s = senders.find((x) => x.track?.kind === kind);
    if (s) Promise.resolve(s.replaceTrack(track)).catch(() => {});
  }
  const old = kind === "video"
    ? state.stream.getVideoTracks()[0]
    : state.stream.getAudioTracks()[0];
  if (old) {
    state.stream.removeTrack(old);
    try { old.stop(); } catch {}
  }
  state.stream.addTrack(track);
  attachLocal();
}

async function toggleCam() {
  if (state.videoIsFake && !FAKE) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      replaceTrackEverywhere("video", s.getVideoTracks()[0]);
      state.videoIsFake = false;
      state.camOn = true;
      setNote("");
    } catch (err) {
      setNote(cameraNote(err));
      addSystem(cameraNote(err));
    }
  } else {
    const t = state.stream?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    state.camOn = t.enabled;
  }
  updateControls();
}

async function toggleMic() {
  if (state.audioIsFake && !FAKE) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
      replaceTrackEverywhere("audio", s.getAudioTracks()[0]);
      state.audioIsFake = false;
      state.micOn = true;
    } catch {
      addSystem("Microphone blocked — allow access and press the mic button again.");
    }
  } else {
    const t = state.stream?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    state.micOn = t.enabled;
  }
  updateControls();
}

/* ------------------------------ device setup ------------------------------- */

async function openSetup() {
  $("setupModal").hidden = false;
  const v = $("setupVideo");
  v.srcObject = state.stream;
  v.classList.toggle("mirror", !state.videoIsFake);
  const devs = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  const saved = savedDevices();
  fillDeviceSelect($("camSelect"), devs.filter((d) => d.kind === "videoinput"), "Camera", saved.video);
  fillDeviceSelect($("micSelect"), devs.filter((d) => d.kind === "audioinput"), "Microphone", saved.audio);
}

function fillDeviceSelect(sel, devices, label, savedId) {
  sel.innerHTML = "";
  if (!devices.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = `Default ${label.toLowerCase()}`;
    sel.appendChild(o);
    return;
  }
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `${label} ${i + 1}`;
    if (d.deviceId === savedId) o.selected = true;
    sel.appendChild(o);
  });
}

async function saveSetup() {
  store.set("wp-devices", JSON.stringify({
    video: $("camSelect").value || "",
    audio: $("micSelect").value || "",
  }));
  if (!FAKE && navigator.mediaDevices?.getUserMedia) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(),
        audio: audioConstraints(),
      });
      replaceTrackEverywhere("video", s.getVideoTracks()[0]);
      replaceTrackEverywhere("audio", s.getAudioTracks()[0]);
      state.videoIsFake = false;
      state.audioIsFake = false;
      state.camOn = true;
      state.micOn = true;
      updateControls();
      setNote("");
    } catch (err) {
      setNote(cameraNote(err));
      addSystem(cameraNote(err));
    }
  }
  $("setupModal").hidden = true;
}

/* ---------------------------------- rooms ---------------------------------- */

const WORDS_A = ["sunny", "cosmic", "mellow", "ruby", "lucky", "velvet", "neon", "polar", "magic", "turbo"];
const WORDS_B = ["tiger", "panda", "otter", "falcon", "comet", "llama", "mango", "pixel", "nova", "koala"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const makeCode = () =>
  `${pick(WORDS_A)}-${pick(WORDS_B)}-${1000 + Math.floor(Math.random() * 9000)}`;

function peerOpts() {
  const h = params.get("host");
  if (h) {
    return {
      host: h,
      port: Number(params.get("port") || 9000),
      path: params.get("path") || "/",
      secure: params.get("secure") === "1",
    };
  }
  try {
    const saved = JSON.parse(store.get("wp-server") || "null");
    if (saved && saved.host) return saved;
  } catch {}
  return {};
}

function newPeer(id) {
  const opts = peerOpts();
  const p = id ? new Peer(id, opts) : new Peer(opts);
  p.on("connection", acceptConn);
  p.on("call", acceptCall);
  p.on("disconnected", () => { try { p.reconnect(); } catch {} });
  return p;
}

function entry(pid) {
  let e = state.peers.get(pid);
  if (!e) {
    e = {
      id: pid,
      profile: { name: "Guest", color: "", avatar: "🍿", badge: "" },
      conn: null, call: null, tile: null, video: null, tag: null, announced: false,
    };
    state.peers.set(pid, e);
  }
  return e;
}

function acceptConn(conn) {
  const isNew = !state.peers.has(conn.peer);
  if (state.role === "host" && isNew && state.peers.size >= MAX_PARTICIPANTS - 1) {
    conn.on("open", () => {
      conn.send({ type: "full" });
      setTimeout(() => { try { conn.close(); } catch {} }, 400);
    });
    return;
  }
  registerConn(conn);
}

function acceptCall(call) {
  const e = entry(call.peer);
  if (e.call) { try { call.close(); } catch {} return; }
  call.answer(state.stream);
  registerCall(call);
}

function registerConn(conn, outgoing) {
  const e = entry(conn.peer);
  e.conn = conn;
  // metadata on an incoming connection describes the remote peer; on an
  // outgoing one it's our own profile (meant for them) — don't read it back.
  if (!outgoing && conn.metadata?.name) setPeerProfile(e, conn.metadata);
  conn.on("open", () => {
    conn.send(profileMsg("hello"));
    // The host introduces the newcomer to everyone already in the room; the
    // newcomer then dials each of them directly (full mesh).
    if (state.role === "host") {
      const others = [...state.peers.values()]
        .filter((x) => x.id !== conn.peer && x.conn?.open)
        .map((x) => ({ id: x.id }));
      conn.send({ type: "roster", peers: others });
      // Land the newcomer at the host's current position and play state.
      const lv = latestVideoState();
      if (lv) conn.send({ type: "sync-state", time: lv.time, paused: lv.paused });
    }
    announce(e);
    refreshStatus();
    enableChat(true);
  });
  conn.on("data", (msg) => handleData(e, msg));
  conn.on("close", () => removePeer(e.id));
  conn.on("error", () => {});
}

function registerCall(call, outgoing) {
  const e = entry(call.peer);
  e.call = call;
  if (!outgoing && call.metadata?.name) setPeerProfile(e, call.metadata);
  call.on("stream", (remote) => {
    addTile(e);
    e.video.srcObject = remote;
    playSafe(e.video);
  });
  call.on("error", () => {});
}

function dialPeer(pid) {
  if (!state.peer || pid === state.peer.id) return;
  if (state.peers.get(pid)?.conn) return;
  const meta = { name: profile.name, color: profile.color, avatar: profile.avatar, badge: profile.badge };
  registerConn(state.peer.connect(pid, { metadata: meta }), true);
  registerCall(state.peer.call(pid, state.stream, { metadata: meta }), true);
}

function handleData(e, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello":
      setPeerProfile(e, msg);
      announce(e);
      break;
    case "roster":
      (Array.isArray(msg.peers) ? msg.peers : []).forEach((p) => {
        if (p && p.id) dialPeer(String(p.id));
      });
      break;
    case "chat":
      feedChat(sanitizeProfile(msg), String(msg.text || ""));
      break;
    case "react":
      showReaction(String(msg.emoji || "").slice(0, 4));
      break;
    case "sync":
      onRemoteSync(e, msg);
      break;
    case "sync-req":
      onSyncRequest(e, msg);
      break;
    case "sync-state":
    case "sync-tick":
      onHostTick(e, msg);
      break;
    case "ctrl":
      if (e.id === hostId()) {
        state.canControl = !!msg.allowed;
        addSystem(
          state.canControl
            ? `${e.profile.name} gave you the remote — you can control playback now`
            : `${e.profile.name} took back playback control`
        );
      }
      break;
    case "full":
      setStatus("err", "Room is full");
      addSystem(`That room is full (up to ${MAX_PARTICIPANTS} people).`);
      break;
    case "bye":
      removePeer(e.id);
      break;
  }
}

function sanitizeProfile(src) {
  return {
    name: String(src.name || "Guest").trim().slice(0, 20) || "Guest",
    color: NAME_COLORS.includes(src.color) ? src.color : "",
    avatar: AVATARS.includes(src.avatar) ? src.avatar : "🍿",
    badge: BADGES.includes(src.badge) ? src.badge : "",
  };
}

function setPeerProfile(e, src) {
  e.profile = sanitizeProfile(src);
  if (e.tag) e.tag.textContent = e.profile.name;
}

function announce(e) {
  if (e.announced || e.profile.name === "Guest") return;
  e.announced = true;
  feedEvent(e.profile, "joined the party 🎉");
}

function removePeer(pid) {
  const e = state.peers.get(pid);
  if (!e) return;
  state.peers.delete(pid);
  try { e.conn?.close(); } catch {}
  try { e.call?.close(); } catch {}
  e.tile?.remove();
  if (e.announced) feedEvent(e.profile, "left the party");
  layoutGrid();
  refreshStatus();
  if (state.peers.size === 0) enableChat(false);
}

function refreshStatus() {
  const n = state.peers.size;
  if (n > 0) setStatus("ok", n === 1 ? "Connected" : `Connected · ${n + 1} in room`);
  else if (state.role === "host") setStatus("wait", "Waiting for friends…");
  else if (state.room) setStatus("err", "Disconnected");
}

function broadcast(obj) {
  for (const e of state.peers.values()) {
    if (e.conn?.open) { try { e.conn.send(obj); } catch {} }
  }
}

function requireName() {
  const v = $("nameInput").value.trim();
  if (v) profile.name = v.slice(0, 20);
  if (!profile.name) {
    setNote("Enter your name first.");
    $("nameInput").focus();
    return false;
  }
  saveProfile();
  renderProfileUI();
  return true;
}

async function createRoom() {
  if (state.peer || !requireName()) return;
  await ensureStream();
  state.role = "host";
  startHost(makeCode(), 0);
}

function startHost(code, attempt) {
  setStatus("wait", "Creating room…");
  const p = newPeer(code);
  state.peer = p;
  p.on("open", (id) => {
    state.room = id;
    enterRoom();
    refreshStatus();
    feedEvent(profile, "created the party 🎉");
    addSystem(`Share the code ${id} — up to ${MAX_PARTICIPANTS} people can join.`);
  });
  p.on("error", (err) => {
    if (err?.type === "unavailable-id" && attempt < 3) {
      startHost(makeCode(), attempt + 1);
      return;
    }
    handlePeerError(err);
  });
}

async function joinRoom(codeRaw) {
  if (state.peer || !requireName()) return;
  const code = String(codeRaw || "").trim().toLowerCase();
  if (!code) return;
  await ensureStream();
  state.role = "guest";
  setStatus("wait", "Joining room…");
  const p = newPeer();
  state.peer = p;
  p.on("open", () => {
    state.room = code;
    enterRoom();
    dialPeer(code);
  });
  p.on("error", handlePeerError);
}

function handlePeerError(err) {
  const t = err?.type || "";
  if (t === "peer-unavailable") {
    setStatus("err", "Room not found");
    addSystem("No room with that code — double-check it and try again.");
  } else if (t === "network") {
    setStatus("err", "No signal");
    addSystem("Can't reach the signaling server — check your internet connection (or the server address in Settings).");
  } else if (t === "unavailable-id") {
    setStatus("err", "Code taken — try again");
  } else {
    setStatus("err", "Connection error");
    console.warn("[watchparty]", err);
  }
}

function leaveRoom() {
  broadcast({ type: "bye" });
  try { state.peer?.destroy(); } catch {}
  setTimeout(() => location.reload(), 200);
}

/* ------------------------------ playback sync ------------------------------ */
// Host-authoritative, always on: the room creator's player is the source of
// truth. Guests follow automatically (play/pause/seek and position). Only the
// host controls playback, unless the host hands a guest the remote.

let lastSyncSent = 0;
let lastSeekFeed = 0;
let lastNoCtrlNote = 0;

const fmtTime = (t) => {
  t = Math.max(0, Math.round(Number(t) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const syncEventText = (kind, time) =>
  kind === "play" ? `started playing the video at ${fmtTime(time)}`
  : kind === "pause" ? "paused the video"
  : `jumped to ${fmtTime(time)}`;

const hostId = () => (state.role === "guest" ? state.room : null);

function queryPageVideo() {
  if (FRAMED) parent.postMessage({ source: "watchparty", action: "video-query" }, "*");
}

function applySyncLocal(kind, time) {
  if (!FRAMED) return;
  parent.postMessage(
    { source: "watchparty", action: "video-control", cmd: kind, time: Number(time) || 0 },
    "*"
  );
}

function feedSyncEvent(p, kind, time) {
  const now = Date.now();
  if (kind === "seek") {
    if (now - lastSeekFeed < 2000) return;
    lastSeekFeed = now;
  }
  feedEvent(p, syncEventText(kind, time));
}

// The host's current player position, extrapolated from the last poll.
function latestVideoState() {
  const lv = state.lastVideo;
  if (!lv) return null;
  return {
    paused: lv.paused,
    time: lv.time + (lv.paused ? 0 : (Date.now() - lv.at) / 1000),
  };
}

// This user touched their own player (play/pause/seek).
function onPageVideoEvent(d) {
  if (!state.room) return;
  const now = Date.now();
  if (now - lastSyncSent < 250) return;
  lastSyncSent = now;
  if (state.role === "host") {
    broadcast({ type: "sync", kind: d.kind, time: d.time, by: profile.name });
    feedSyncEvent(profile, d.kind, d.time);
  } else if (state.canControl) {
    const host = state.peers.get(hostId());
    if (host?.conn?.open) host.conn.send({ type: "sync-req", kind: d.kind, time: d.time });
    feedSyncEvent(profile, d.kind, d.time);
  } else if (now - lastNoCtrlNote > 8000) {
    lastNoCtrlNote = now;
    addSystem("Only the host controls playback — ask them to hand you the remote.");
  }
}

// A sync command arrived. Guests obey the host and no one else.
function onRemoteSync(e, msg) {
  if (state.role !== "guest" || e.id !== hostId()) return;
  const kind = String(msg.kind || "");
  if (!["play", "pause", "seek"].includes(kind)) return;
  if (msg.by === profile.name) return; // our own action, echoed back by the host
  const src =
    [...state.peers.values()].find((p) => p.profile.name === msg.by)?.profile || e.profile;
  feedSyncEvent(src, kind, msg.time);
  applySyncLocal(kind, msg.time);
}

// An authorized guest asked the host to change playback.
function onSyncRequest(e, msg) {
  if (state.role !== "host" || !state.allowed.has(e.id)) return;
  const kind = String(msg.kind || "");
  if (!["play", "pause", "seek"].includes(kind)) return;
  applySyncLocal(kind, msg.time);
  broadcast({ type: "sync", kind, time: msg.time, by: e.profile.name });
  feedSyncEvent(e.profile, kind, msg.time);
}

// Position report from the host (on join, then every ~10s) — correct drift.
function onHostTick(e, msg) {
  if (state.role !== "guest" || e.id !== hostId()) return;
  state.pendingTick = { time: Number(msg.time) || 0, paused: !!msg.paused, at: Date.now() };
  queryPageVideo();
}

function toggleGrant(e) {
  const allowed = !state.allowed.has(e.id);
  if (allowed) state.allowed.add(e.id);
  else state.allowed.delete(e.id);
  e.grantBtn?.classList.toggle("on", allowed);
  if (e.grantBtn) {
    e.grantBtn.title = allowed
      ? `${e.profile.name} has the remote — click to take it back`
      : `Hand ${e.profile.name} the remote (play/pause/seek)`;
  }
  if (e.conn?.open) e.conn.send({ type: "ctrl", allowed });
  addSystem(
    allowed
      ? `${e.profile.name} can now control playback`
      : `${e.profile.name} can no longer control playback`
  );
}

/* -------------------------------- reactions -------------------------------- */

function sendReaction(emoji) {
  broadcast({ type: "react", emoji });
  showReaction(emoji);
}

function showReaction(emoji) {
  if (!emoji) return;
  const layer = $("floatLayer");
  const s = document.createElement("span");
  s.className = "float-emoji";
  s.textContent = emoji;
  s.style.left = 10 + Math.random() * 75 + "%";
  layer.appendChild(s);
  setTimeout(() => s.remove(), 2100);
}

/* --------------------------------- pop-out --------------------------------- */

function popOut() {
  const q = new URLSearchParams();
  if (profile.name) q.set("name", profile.name);
  if (FAKE) q.set("fake", "1");
  if (state.room) q.set("join", state.room);
  const url = "sidebar.html" + (q.toString() ? "?" + q.toString() : "");
  const w = window.open(url, "watchparty-window", "width=380,height=720,popup=yes");
  if (!w) {
    setNote("Pop-up blocked — allow pop-ups to open WatchParty in its own window.");
    addSystem("Pop-up blocked — allow pop-ups to open WatchParty in its own window.");
    return;
  }
  if (state.room) leaveRoom(); // the popped-out window rejoins the same room
  else if (FRAMED) parent.postMessage({ source: "watchparty", action: "close" }, "*");
}

/* --------------------------------- settings -------------------------------- */

function loadSettingsForm() {
  let saved = null;
  try { saved = JSON.parse(store.get("wp-server") || "null"); } catch {}
  $("serverHost").value = saved?.host || "";
  $("serverPort").value = saved?.port || "";
  $("serverPath").value = saved?.path || "";
  $("serverSecure").checked = !!saved?.secure;
}

function saveSettings() {
  const host = $("serverHost").value.trim();
  if (host) {
    store.set("wp-server", JSON.stringify({
      host,
      port: Number($("serverPort").value) || 9000,
      path: $("serverPath").value.trim() || "/",
      secure: $("serverSecure").checked,
    }));
  } else {
    store.del("wp-server");
  }
  $("settingsPanel").hidden = true;
  const msg = host
    ? `Signaling server set to ${host} — applies when you next create or join a room.`
    : "Using the default PeerJS cloud for signaling.";
  if (state.view === "room") addSystem(msg); else setNote(msg);
}

/* ----------------------------------- ui ----------------------------------- */

function setStatus(kind, text) {
  $("statusPill").className = "pill " + (kind || "");
  $("statusText").textContent = text;
}

function setNote(text) {
  const el = $("note");
  el.textContent = text;
  el.hidden = !text;
}

function showView(v) {
  if (v === "profile" && state.view !== "profile") state.viewBefore = state.view;
  state.view = v;
  $("lobby").hidden = v !== "lobby";
  $("room").hidden = v !== "room";
  $("profile").hidden = v !== "profile";
}

function enterRoom() {
  showView("room");
  $("roomCode").textContent = state.room;
  attachLocal();
  layoutGrid();
  queryPageVideo();
}

function enableChat(on) {
  $("chatInput").disabled = !on;
  $("sendBtn").disabled = !on;
  if (on && state.view === "room") $("chatInput").focus();
}

function playSafe(v) {
  const p = v.play();
  if (p?.catch) p.catch(() => {
    // Autoplay with sound was blocked — start muted so video shows, then
    // restore sound on the user's next click anywhere in the panel.
    v.muted = true;
    v.play().catch(() => {});
    document.addEventListener("click", () => {
      v.muted = false;
      v.play().catch(() => {});
    }, { once: true });
  });
}

function addTile(e) {
  if (e.tile) return;
  const tile = document.createElement("div");
  tile.className = "tile";
  const vid = document.createElement("video");
  vid.autoplay = true;
  vid.playsInline = true;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = e.profile.name;
  tile.append(vid, tag);
  // The host can hand this person the remote from their tile.
  if (state.role === "host") {
    const grant = document.createElement("button");
    grant.className = "grant";
    grant.type = "button";
    grant.title = `Hand ${e.profile.name} the remote (play/pause/seek)`;
    grant.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="7" r="1"/><line x1="10" y1="12" x2="14" y2="12"/><line x1="10" y1="16" x2="14" y2="16"/></svg>';
    grant.addEventListener("click", () => toggleGrant(e));
    tile.appendChild(grant);
    e.grantBtn = grant;
  }
  $("remoteGrid").appendChild(tile);
  e.tile = tile;
  e.video = vid;
  e.tag = tag;
  layoutGrid();
}

function layoutGrid() {
  const n = $("remoteGrid").children.length;
  $("remoteGrid").dataset.count = String(n);
  $("remoteEmpty").hidden = n > 0;
}

/* ------------------------------- chat feed --------------------------------- */

let lastActor = null;

function makeAvatar(p, cls) {
  const a = document.createElement("span");
  a.className = "avatar" + (cls ? " " + cls : "");
  a.textContent = p.avatar || "🍿";
  a.style.background = avatarBg(p.avatar);
  return a;
}

// One feed row, Teleparty-style: avatar + colored name on the actor's first
// row, then name-less continuation rows while the same person keeps acting.
function addRow(p, text, kind) {
  const log = $("chatLog");
  const cont = lastActor === p.name;
  lastActor = p.name;
  const row = document.createElement("div");
  row.className = "row" + (cont ? " cont" : "");
  const rc = document.createElement("div");
  rc.className = "rc";
  if (!cont) {
    row.appendChild(makeAvatar(p));
    const nameEl = document.createElement("div");
    nameEl.className = "rname";
    const nm = document.createElement("span");
    nm.textContent = p.name;
    if (p.color) nm.style.color = p.color;
    nameEl.appendChild(nm);
    if (p.badge) {
      const b = document.createElement("span");
      b.className = "rbadge";
      b.textContent = p.badge;
      nameEl.appendChild(b);
    }
    const tm = document.createElement("span");
    tm.className = "rtime";
    tm.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    nameEl.appendChild(tm);
    rc.appendChild(nameEl);
  }
  const txt = document.createElement("div");
  txt.className = kind === "event" ? "revent" : "rtext";
  txt.textContent = text;
  rc.appendChild(txt);
  row.appendChild(rc);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function feedChat(p, text) {
  if (text) addRow(p, text, "chat");
}

function feedEvent(p, text) {
  addRow(p, text, "event");
}

function addSystem(text) {
  lastActor = null;
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  const log = $("chatLog");
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

/* ------------------------------ profile screen ----------------------------- */

function renderProfileUI() {
  const btn = $("avatarBtnEmoji");
  btn.textContent = profile.avatar;
  $("avatarBtn").style.background = avatarBg(profile.avatar);
  const pa = $("profileAvatar");
  pa.textContent = profile.avatar;
  pa.style.background = avatarBg(profile.avatar);
  $("profileName").value = profile.name;
  $("nameInput").value = profile.name;
  updateLobbyButtons();
  const pv = $("previewAvatar");
  pv.textContent = profile.avatar;
  pv.style.background = avatarBg(profile.avatar);
  $("previewName").textContent = profile.name || "You";
  $("previewName").style.color = profile.color || "";
  $("previewBadge").textContent = profile.badge;
  for (const b of $("colorRow").children) b.classList.toggle("sel", b.dataset.color === profile.color);
  for (const b of $("badgeRow").children) b.classList.toggle("sel", b.dataset.badge === profile.badge);
  for (const b of $("avatarGrid").children) b.classList.toggle("sel", b.dataset.avatar === profile.avatar);
}

function profileChanged() {
  saveProfile();
  renderProfileUI();
  broadcast(profileMsg("hello"));
}

function buildProfileControls() {
  const colorRow = $("colorRow");
  NAME_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.color = c;
    b.style.background = c || "#e8e6e3";
    b.title = c ? "Name color" : "Default";
    b.addEventListener("click", () => { profile.color = c; profileChanged(); });
    colorRow.appendChild(b);
  });
  const badgeRow = $("badgeRow");
  BADGES.forEach((bd) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.badge = bd;
    b.textContent = bd || "None";
    if (!bd) b.classList.add("none");
    b.addEventListener("click", () => { profile.badge = bd; profileChanged(); });
    badgeRow.appendChild(b);
  });
  const grid = $("avatarGrid");
  AVATARS.forEach((av) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.avatar = av;
    b.textContent = av;
    b.addEventListener("click", () => { profile.avatar = av; profileChanged(); });
    grid.appendChild(b);
  });
  $("profileAvatar").addEventListener("click", () => {
    $("avatarGrid").hidden = !$("avatarGrid").hidden;
  });
  $("profileName").addEventListener("input", () => {
    profile.name = $("profileName").value.trim().slice(0, 20);
    saveProfile();
    $("nameInput").value = profile.name;
    updateLobbyButtons();
    $("previewName").textContent = profile.name || "You";
  });
  $("profileName").addEventListener("change", () => profileChanged());
  $("profileBack").addEventListener("click", () => showView(state.viewBefore));
  $("avatarBtn").addEventListener("click", () => {
    if (state.view === "profile") showView(state.viewBefore);
    else { renderProfileUI(); showView("profile"); }
  });
}

/* --------------------------------- controls -------------------------------- */

function updateControls() {
  const cam = $("camBtn");
  const mic = $("micBtn");
  cam.classList.toggle("off", !state.camOn);
  cam.title = state.videoIsFake
    ? "Turn the camera on"
    : state.camOn ? "Turn the camera off" : "Turn the camera on";
  mic.classList.toggle("off", !state.micOn);
  mic.title = state.audioIsFake
    ? "Turn the microphone on"
    : state.micOn ? "Mute microphone" : "Unmute microphone";
}

function updateLobbyButtons() {
  const hasName = !!$("nameInput").value.trim();
  // Inside a page, a party needs a video to sync — ask for one first.
  const hasVideo = !FRAMED || state.pageVideo;
  $("createBtn").disabled = !(hasName && hasVideo);
  $("joinBtn").disabled = !(hasName && hasVideo);
  if (state.view === "lobby" && FRAMED) {
    const gateMsg = "First select a video — open something to watch on this page, then create or join a room.";
    if (!hasVideo) setNote(gateMsg);
    else if ($("note").textContent === gateMsg) setNote("");
  }
}

function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1200);
}

/* --------------------------------- wiring --------------------------------- */

function wire() {
  $("nameInput").addEventListener("input", () => {
    profile.name = $("nameInput").value.trim().slice(0, 20);
    saveProfile();
    updateLobbyButtons();
    if (profile.name) setNote("");
  });

  $("createBtn").addEventListener("click", createRoom);
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    joinRoom($("joinInput").value);
  });

  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text) return;
    broadcast(profileMsg("chat", { text }));
    feedChat(profile, text);
    input.value = "";
  });

  $("copyBtn").addEventListener("click", async () => {
    const code = state.room || "";
    try {
      await navigator.clipboard.writeText(code);
      flash($("copyLabel"), "Copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); flash($("copyLabel"), "Copied"); } catch {}
      ta.remove();
    }
  });

  $("camBtn").addEventListener("click", toggleCam);
  $("micBtn").addEventListener("click", toggleMic);
  $("leaveBtn").addEventListener("click", leaveRoom);
  $("popoutBtn").addEventListener("click", popOut);

  $("setupBtn").addEventListener("click", openSetup);
  $("setupClose").addEventListener("click", () => { $("setupModal").hidden = true; });
  $("setupSave").addEventListener("click", saveSetup);

  const reactionRow = $("reactionRow");
  REACTIONS.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r;
    b.title = "Send reaction";
    b.addEventListener("click", () => sendReaction(r));
    reactionRow.appendChild(b);
  });

  const emojiPanel = $("emojiPanel");
  EMOJIS.forEach((em) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = em;
    b.addEventListener("click", () => {
      $("chatInput").value += em;
      $("chatInput").focus();
    });
    emojiPanel.appendChild(b);
  });
  $("emojiBtn").addEventListener("click", () => {
    emojiPanel.hidden = !emojiPanel.hidden;
  });

  $("settingsBtn").addEventListener("click", () => {
    const panel = $("settingsPanel");
    if (panel.hidden) loadSettingsForm();
    panel.hidden = !panel.hidden;
  });
  $("settingsSave").addEventListener("click", saveSettings);
  $("settingsClose").addEventListener("click", () => { $("settingsPanel").hidden = true; });

  $("closeBtn").addEventListener("click", () => {
    parent.postMessage({ source: "watchparty", action: "close" }, "*");
  });
  if (!FRAMED) {
    $("closeBtn").style.display = "none";
  }

  buildProfileControls();

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "watchparty-host") return;
    if (d.action === "visibility") {
      if (!d.open && !state.room && !FAKE) stopPreview();
      else if (d.open && !state.stream) ensureStream();
    } else if (d.action === "video-event") {
      onPageVideoEvent(d);
    } else if (d.action === "video-state") {
      state.pageVideo = !!d.available;
      if (state.pageVideo) {
        state.lastVideo = { paused: !!d.paused, time: Number(d.time) || 0, at: Date.now() };
      }
      updateLobbyButtons();
      // A guest compares the host's reported position against its own player.
      if (state.pendingTick && Date.now() - state.pendingTick.at < 3000 && state.pageVideo) {
        const t = state.pendingTick;
        state.pendingTick = null;
        const target = t.time + (t.paused ? 0 : (Date.now() - t.at) / 1000);
        if (Math.abs((Number(d.time) || 0) - target) > 2) applySyncLocal("seek", target);
        if (!!d.paused !== t.paused) applySyncLocal(t.paused ? "pause" : "play", target);
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    broadcast({ type: "bye" });
  });
}

async function init() {
  if (typeof Peer === "undefined") {
    setStatus("err", "PeerJS missing");
    setNote("lib/peerjs.min.js failed to load — reinstall the extension.");
    return;
  }
  wire();
  renderProfileUI();
  setStatus("", "Off air");
  // This is the moment the browser asks for camera/mic permission — right when
  // the sidebar opens on Netflix/YouTube/Prime/anywhere.
  await ensureStream();
  queryPageVideo();

  // Keep watching the page's video: gates the lobby until one is selected,
  // and keeps the host's known position fresh for join-state and drift ticks.
  if (FRAMED) setInterval(queryPageVideo, 4000);
  setInterval(() => {
    if (state.role === "host" && state.room && FRAMED) {
      const lv = latestVideoState();
      if (lv) broadcast({ type: "sync-tick", time: lv.time, paused: lv.paused });
    }
  }, 10000);

  const join = params.get("join");
  if (params.get("create") === "1" && profile.name) {
    createRoom();
  } else if (join) {
    $("joinInput").value = join;
    if (profile.name) joinRoom(join);
    else setNote("Enter your name, then press Join.");
  }
}

document.addEventListener("DOMContentLoaded", init);
