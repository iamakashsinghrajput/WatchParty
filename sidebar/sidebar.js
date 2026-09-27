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

// Profile-sync backend (Railway). Paste your deployed URL here once it's live,
// e.g. "https://watchparty-backend-production.up.railway.app". Left empty, the
// extension works fully but keeps the profile on this device only. Can also be
// overridden at runtime via localStorage "wp-backend".
const DEFAULT_BACKEND_URL = "";
const BACKEND_URL = (store.get("wp-backend") || DEFAULT_BACKEND_URL).replace(/\/+$/, "");

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

// The signed-in Google account (if any). Signing in makes the identity below
// the same across every device and browser.
function loadAccount() {
  try { return JSON.parse(store.get("wp-account") || "null"); } catch { return null; }
}
let account = loadAccount();

// A stable per-user id. When signed in it's the Google account id (consistent
// everywhere); otherwise a random per-browser id. "Who holds the remote" is
// tracked by this, so control survives everyone navigating to a new video.
function computeUid() {
  if (account && account.sub) return "g_" + account.sub;
  let u = store.get("wp-uid");
  if (!u) { u = "u" + Math.random().toString(36).slice(2, 10); store.set("wp-uid", u); }
  return u;
}
let myUid = computeUid();

function saveProfile() {
  store.set("wp-profile", JSON.stringify(profile));
  store.set("wp-name", profile.name);
}

function profileMsg(type, extra) {
  return Object.assign({
    type,
    uid: myUid,
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
  controllerUid: null,  // uid of whoever currently drives content + playback
  lastVideo: null,      // {paused, time, at} last known local page-video state
  pendingTick: null,    // position report awaiting local comparison
  controllerState: null,// {paused, time, at} the controller's authoritative state
  pageHref: "",         // the URL of the page under the sidebar
  lastSharedUrl: "",    // the last video URL I broadcast (while controller)
  lastRoomUrl: "",      // the room's current video URL (for newcomers)
  navigating: false,    // currently opening the controller's video
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

// STUN finds a direct path; the free TURN relays are the fallback when a
// firewall/NAT blocks the direct one — without them a call can spend a long
// time failing over before media flows, which shows up as "no sound for a few
// minutes, then fine". Relaying makes the link come up in seconds.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

function peerOpts() {
  const base = { config: { iceServers: ICE_SERVERS } };
  const h = params.get("host");
  if (h) {
    return Object.assign(base, {
      host: h,
      port: Number(params.get("port") || 9000),
      path: params.get("path") || "/",
      secure: params.get("secure") === "1",
    });
  }
  try {
    const saved = JSON.parse(store.get("wp-server") || "null");
    if (saved && saved.host) return Object.assign(base, saved);
  } catch {}
  return base;
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
      uid: null,
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
    // The host introduces the newcomer to everyone already in the room, tells
    // them who holds the remote and what's playing, and lands them at the
    // current position. The newcomer then dials the others directly (mesh).
    if (state.role === "host") {
      const others = [...state.peers.values()]
        .filter((x) => x.id !== conn.peer && x.conn?.open)
        .map((x) => ({ id: x.id }));
      conn.send({ type: "roster", peers: others });
      conn.send({ type: "controller", uid: state.controllerUid });
      const url = iAmController() ? state.pageHref : state.lastRoomUrl;
      if (url) conn.send({ type: "open-video", url, uid: state.controllerUid });
      const cs = controllerCurrentState();
      if (cs) conn.send({ type: "sync-tick", time: cs.time, paused: cs.paused, uid: state.controllerUid });
      // If this uid was the controller before a reconnect, restore its remote.
      if (e.uid && e.uid === state.controllerUid && e.uid !== myUid) {
        conn.send({ type: "controller", uid: state.controllerUid });
      }
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
    playSafe(e.video);       // muted video (picture only)
    playRemoteAudio(e, remote); // sound via the unlocked Web Audio graph
  });
  call.on("error", () => {});
}

function dialPeer(pid) {
  if (!state.peer || pid === state.peer.id) return;
  if (state.peers.get(pid)?.conn) return;
  const meta = { uid: myUid, name: profile.name, color: profile.color, avatar: profile.avatar, badge: profile.badge };
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
    case "sync-tick":
      onControllerTick(e, msg);
      break;
    case "open-video":
      if (state.role === "host") state.lastRoomUrl = String(msg.url || "");
      onOpenVideo(String(msg.uid || e.uid || ""), String(msg.url || ""));
      break;
    case "controller":
      // Only the host assigns the remote; everyone else trusts that.
      if (isHostPeer(e)) applyController(String(msg.uid || ""));
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

// The host is the peer whose id is the room code.
function isHostPeer(e) {
  return state.role === "guest" && e.id === state.room;
}

function setPeerProfile(e, src) {
  e.profile = sanitizeProfile(src);
  if (src.uid) e.uid = String(src.uid);
  if (e.tag) e.tag.textContent = e.profile.name;
  // A returning controller (same uid, new peer id) gets its remote restored.
  if (state.role === "host" && e.uid && e.uid === state.controllerUid) {
    clearTimeout(reclaimTimer);
    updateGrantButtons();
    if (e.conn?.open) e.conn.send({ type: "controller", uid: state.controllerUid });
  }
}

// A member who leaves and comes back within a few seconds was just navigating
// to the room's new video — don't spam the feed with left/joined for that.
const recentlyLeft = new Map(); // uid -> timer

function announce(e) {
  if (e.uid && recentlyLeft.has(e.uid)) {
    clearTimeout(recentlyLeft.get(e.uid));
    recentlyLeft.delete(e.uid);
    e.announced = true; // they were already in the room; skip the "joined" note
    return;
  }
  if (e.announced || e.profile.name === "Guest") return;
  e.announced = true;
  feedEvent(e.profile, "joined the party 🎉");
}

let reclaimTimer = null;

function removePeer(pid) {
  const e = state.peers.get(pid);
  if (!e) return;
  state.peers.delete(pid);
  try { e.conn?.close(); } catch {}
  try { e.call?.close(); } catch {}
  try { e.audioNode?.disconnect(); } catch {}
  e.tile?.remove();
  // Hold the "left the party" note briefly; if they reconnect (a video change),
  // announce() cancels it so the reconnect stays silent.
  if (e.announced && e.uid) {
    const prof = e.profile;
    recentlyLeft.set(e.uid, setTimeout(() => {
      recentlyLeft.delete(e.uid);
      feedEvent(prof, "left the party");
    }, 5000));
  } else if (e.announced) {
    feedEvent(e.profile, "left the party");
  }
  // If the person who held the remote just dropped, give them a moment to
  // reconnect (they may be navigating); if they don't come back, the host
  // takes the remote back so the room isn't stuck.
  if (state.role === "host" && e.uid && e.uid === state.controllerUid && e.uid !== myUid) {
    clearTimeout(reclaimTimer);
    reclaimTimer = setTimeout(() => {
      const stillHere = [...state.peers.values()].some((p) => p.uid === state.controllerUid);
      if (!stillHere) setController(myUid);
    }, 12000);
  }
  layoutGrid();
  refreshStatus();
  if (state.peers.size === 0) enableChat(false);
}

function refreshStatus() {
  const n = state.peers.size;
  if (n > 0) setStatus("ok", n === 1 ? "Connected" : `Connected · ${n + 1} in room`);
  // Someone briefly gone (mid video-change) — hold "Connected" instead of
  // flashing back to the waiting state.
  else if (recentlyLeft.size > 0) setStatus("ok", "Connected");
  else if (state.role === "host") setStatus("wait", "Waiting for friends…");
  else if (state.room) setStatus("err", "Disconnected");
}

function broadcast(obj) {
  for (const e of state.peers.values()) {
    if (e.conn?.open) { try { e.conn.send(obj); } catch {} }
  }
}

function requireName() {
  // Creating or joining a room requires a signed-in account.
  if (!account) {
    setNote("Sign in with Google to create or join a room.");
    renderAuthUI();
    return false;
  }
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
  primeAudio(); // this click is a user gesture — unlock audio playback now
  await ensureStream();
  state.role = "host";
  state.controllerUid = myUid; // the host starts holding the remote
  startHost(makeCode(), 0, false);
}

// Re-create a room on the same code after the controller navigated to a new
// video (the host must reclaim the room and restore who holds the remote).
async function rehostRoom(code) {
  if (state.peer || !requireName()) return;
  await ensureStream();
  state.role = "host";
  state.controllerUid = store.get("wp-ctrl-" + code) || myUid;
  startHost(code, 0, true);
}

function startHost(code, attempt, keepCode) {
  setStatus("wait", "Creating room…");
  const p = newPeer(code);
  state.peer = p;
  p.on("open", (id) => {
    state.room = id;
    if (!state.controllerUid) state.controllerUid = myUid;
    persistController();
    enterRoom();
    refreshStatus();
    if (!keepCode) feedEvent(profile, "created the party 🎉");
    addSystem(`Share the code ${id} — up to ${MAX_PARTICIPANTS} people can join.`);
  });
  p.on("error", (err) => {
    if (err?.type === "unavailable-id" && attempt < (keepCode ? 10 : 3)) {
      try { p.destroy(); } catch {}
      state.peer = null;
      if (keepCode) {
        // The signaling server still holds our old id for a few seconds after
        // the navigation dropped it — wait and reclaim the SAME code.
        setTimeout(() => startHost(code, attempt + 1, true), 1200);
      } else {
        startHost(makeCode(), attempt + 1, false);
      }
      return;
    }
    handlePeerError(err);
  });
}

async function joinRoom(codeRaw, rejoinAttempt) {
  if (state.peer || !requireName()) return;
  const code = String(codeRaw || "").trim().toLowerCase();
  if (!code) return;
  if (!rejoinAttempt) primeAudio(); // Join click is a gesture — unlock audio
  await ensureStream();
  state.role = "guest";
  setStatus("wait", rejoinAttempt ? "Reconnecting…" : "Joining room…");
  const p = newPeer();
  state.peer = p;
  p.on("open", () => {
    state.room = code;
    enterRoom();
    dialPeer(code);
  });
  p.on("error", (err) => {
    // On a rejoin the host may still be re-registering after its own
    // navigation — retry a few times before giving up.
    if (err?.type === "peer-unavailable" && (rejoinAttempt || 0) < 8) {
      try { p.destroy(); } catch {}
      state.peer = null;
      setTimeout(() => joinRoom(code, (rejoinAttempt || 0) + 1), 1500);
      return;
    }
    handlePeerError(err);
  });
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
  if (state.room) store.del("wp-ctrl-" + state.room);
  if (FRAMED) parent.postMessage({ source: "watchparty", action: "clear-session" }, "*");
  setTimeout(() => location.reload(), 200);
}

/* --------------------------- controller-driven sync --------------------------- */
// One person holds the remote at a time — the "controller" (the host by
// default). The controller drives BOTH what's playing (the video URL) and
// playback (play/pause/seek/position); everyone else follows and cannot
// diverge. The host can hand the remote to a guest, and it survives everyone
// navigating to the new video (the remote is tracked by a stable user id).

let lastSyncSent = 0;
let lastSyncKind = "";
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

const iAmController = () => state.controllerUid === myUid;

function controllerProfile() {
  if (iAmController()) return profile;
  for (const e of state.peers.values()) if (e.uid === state.controllerUid) return e.profile;
  return { name: "the host" };
}

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

// My current player position, extrapolated (used when I'm the controller).
function latestVideoState() {
  const lv = state.lastVideo;
  if (!lv) return null;
  return { paused: lv.paused, time: lv.time + (lv.paused ? 0 : (Date.now() - lv.at) / 1000) };
}

// The controller's current position — my own if I'm controlling, else the last
// state I heard from the controller, extrapolated forward.
function controllerCurrentState() {
  if (iAmController()) return latestVideoState();
  const cs = state.controllerState;
  if (!cs) return null;
  return { paused: cs.paused, time: cs.time + (cs.paused ? 0 : (Date.now() - cs.at) / 1000) };
}

function noteControllerState(kind, time) {
  const prev = state.controllerState;
  let paused = prev ? prev.paused : true;
  if (kind === "play") paused = false;
  else if (kind === "pause") paused = true;
  state.controllerState = { paused, time: Number(time) || 0, at: Date.now() };
}

// This user touched their own player.
function onPageVideoEvent(d) {
  if (!state.room) return;
  const now = Date.now();
  // Coalesce only rapid repeats of the SAME kind (e.g. scrubbing fires many
  // seeks); never drop a play/pause that lands right after a seek.
  if (d.kind === lastSyncKind && now - lastSyncSent < 250) return;
  lastSyncSent = now;
  lastSyncKind = d.kind;
  if (iAmController()) {
    // I hold the remote — my action drives everyone.
    broadcast({ type: "sync", kind: d.kind, time: d.time, uid: myUid });
    feedSyncEvent(profile, d.kind, d.time);
  } else {
    // I don't hold the remote — snap back to the controller so I can't diverge.
    const cs = controllerCurrentState();
    if (cs) applySyncLocal(cs.paused ? "pause" : "play", cs.time);
    if (now - lastNoCtrlNote > 8000) {
      lastNoCtrlNote = now;
      addSystem(`${controllerProfile().name} has the remote — ask them to hand it to you.`);
    }
  }
}

// A playback command from the controller — everyone else applies it.
function onRemoteSync(e, msg) {
  if (String(msg.uid || e.uid) !== state.controllerUid) return; // only the controller
  const kind = String(msg.kind || "");
  if (!["play", "pause", "seek"].includes(kind)) return;
  noteControllerState(kind, msg.time);
  if (state.controllerUid === myUid) return; // I'm the controller; ignore echoes
  feedSyncEvent(controllerProfile(), kind, msg.time);
  applySyncLocal(kind, msg.time);
}

// Position heartbeat from the controller — correct drift / land newcomers.
function onControllerTick(e, msg) {
  if (String(msg.uid || e.uid) !== state.controllerUid) return;
  if (iAmController()) return;
  state.controllerState = { time: Number(msg.time) || 0, paused: !!msg.paused, at: Date.now() };
  state.pendingTick = { time: Number(msg.time) || 0, paused: !!msg.paused, at: Date.now() };
  queryPageVideo();
}

/* --------------------------- who holds the remote --------------------------- */

function persistRejoinIfDriving() {
  // The host and the current controller keep a one-shot rejoin ready so the
  // room survives them navigating to a new video; nobody else does.
  if (!FRAMED || !state.room) return;
  if (state.role === "host" || iAmController()) {
    parent.postMessage(
      { source: "watchparty", action: "persist-rejoin", code: state.room, role: state.role },
      "*"
    );
  }
}

function persistController() {
  if (state.room) store.set("wp-ctrl-" + state.room, state.controllerUid || "");
}

// The host assigns the remote (to a guest, or back to itself) and tells everyone.
function setController(uid) {
  if (state.role !== "host") return;
  state.controllerUid = uid || myUid;
  persistController();
  broadcast({ type: "controller", uid: state.controllerUid });
  onControllerChanged();
}

// Everyone (including the host) reacts to a change of who holds the remote.
function applyController(uid) {
  if (uid === state.controllerUid) return;
  state.controllerUid = uid || null;
  onControllerChanged();
}

function onControllerChanged() {
  updateGrantButtons();
  const name = iAmController() ? "You" : controllerProfile().name;
  addSystem(iAmController() ? "You now hold the remote — everyone follows your video." : `${name} now holds the remote.`);
  if (iAmController()) {
    // I'm driving now: (re)share my current video + position, and keep a rejoin
    // ready so my navigations carry the room along.
    state.lastSharedUrl = "";
    persistRejoinIfDriving();
    shareMyVideo();
    const cs = latestVideoState();
    if (cs) broadcast({ type: "sync-tick", time: cs.time, paused: cs.paused, uid: myUid });
  } else if (state.role !== "host") {
    // I no longer drive — a plain guest shouldn't keep the room sticky.
    if (FRAMED) parent.postMessage({ source: "watchparty", action: "clear-session" }, "*");
  }
}

function updateGrantButtons() {
  for (const e of state.peers.values()) {
    if (!e.grantBtn) continue;
    const on = e.uid && e.uid === state.controllerUid;
    e.grantBtn.classList.toggle("on", on);
    e.grantBtn.title = on
      ? `${e.profile.name} holds the remote — click to take it back`
      : `Hand ${e.profile.name} the remote`;
  }
}

// Host clicks the remote button on a guest's tile.
function toggleGrant(e) {
  if (state.role !== "host" || !e.uid) return;
  setController(e.uid === state.controllerUid ? myUid : e.uid);
}

/* ------------------------------ content sync ------------------------------- */
// The controller shares which video everyone watches; the rest auto-open it.

function sameVideo(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

// I'm the controller on a watch page — share its URL with the room.
function shareMyVideo() {
  if (!iAmController() || !state.pageVideo || !state.pageHref) return;
  if (state.pageHref === state.lastSharedUrl) return;
  state.lastSharedUrl = state.pageHref;
  state.lastRoomUrl = state.pageHref;
  broadcast({ type: "open-video", url: state.pageHref, uid: myUid });
}

// The controller changed the video — everyone else opens it.
function onOpenVideo(fromUid, url) {
  if (!FRAMED || !url) return;
  if (fromUid !== state.controllerUid) return; // only follow the controller
  if (iAmController()) return;                  // don't follow myself
  if (state.navigating) return;
  if (state.pageHref && sameVideo(url, state.pageHref)) return;
  state.navigating = true;
  // Safety: if the navigation doesn't actually happen (blocked, same page),
  // clear the flag so a later video change still gets followed.
  setTimeout(() => { state.navigating = false; }, 6000);
  addSystem(`Opening ${controllerProfile().name}'s video…`);
  // Store a one-shot rejoin (code + my role) and navigate; the sidebar
  // auto-rejoins this same room once, on the new page.
  parent.postMessage(
    { source: "watchparty", action: "navigate", url, code: state.room, role: state.role },
    "*"
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
  persistRejoinIfDriving(); // host/controller keep the room across navigation
}

function enableChat(on) {
  $("chatInput").disabled = !on;
  $("sendBtn").disabled = !on;
  if (on && state.view === "room") $("chatInput").focus();
}

// Remote audio. Browsers block un-muted <video> autoplay until a gesture in
// THAT document — and on a streaming site the user's clicks land on the movie,
// not on our sidebar iframe, so the tile's own audio could stay muted for a
// long time. Instead we route each remote stream's audio through a Web Audio
// graph that we unlock on the create/join click; the tile <video> stays muted
// (it only shows the picture). This is the reliable way to get sound the
// instant a peer connects. (A muted playing <video> is also kept because Chrome
// won't emit a remote stream's audio through Web Audio without one.)
let sharedAudioCtx = null;

function audioCtx() {
  if (!sharedAudioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      sharedAudioCtx = new Ctx();
    } catch {}
  }
  return sharedAudioCtx;
}

function primeAudio() {
  audioCtx()?.resume?.().catch(() => {});
}

function resumeAudio() {
  audioCtx()?.resume?.().catch(() => {});
}

function playRemoteAudio(e, stream) {
  const ctx = audioCtx();
  if (!ctx || !stream.getAudioTracks().length) return;
  try {
    if (e.audioNode) { try { e.audioNode.disconnect(); } catch {} }
    e.audioNode = ctx.createMediaStreamSource(stream);
    e.audioNode.connect(ctx.destination);
  } catch {}
  ctx.resume().catch(() => {});
}

function playSafe(v) {
  v.muted = true; // audio flows through Web Audio, not the element
  const p = v.play();
  if (p?.catch) p.catch(() => { v.play().catch(() => {}); });
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
  updateGrantButtons(); // reflect who currently holds the remote
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
  pushProfileToBackend(); // sync the change to the user's account
}

/* --------------------------------- auth ---------------------------------- */

const identityApi = globalThis.chrome?.identity || globalThis.browser?.identity;

// Talk to the profile-sync backend with the Google token, if one is configured.
async function backendFetch(path, options = {}) {
  if (!BACKEND_URL || !account?.token) return null;
  try {
    const res = await fetch(BACKEND_URL + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + account.token,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Apply a profile that came back from the backend onto the local one.
function applyServerProfile(p) {
  if (!p) return;
  if (typeof p.name === "string" && p.name) profile.name = p.name.slice(0, 20);
  if (AVATARS.includes(p.avatar)) profile.avatar = p.avatar;
  if (NAME_COLORS.includes(p.color)) profile.color = p.color;
  if (BADGES.includes(p.badge)) profile.badge = p.badge;
  saveProfile();
  renderProfileUI();
}

// Push the current profile to the backend (debounced by the caller).
function pushProfileToBackend() {
  if (!BACKEND_URL || !account) return;
  backendFetch("/profile", {
    method: "PUT",
    body: JSON.stringify({
      name: profile.name, avatar: profile.avatar, color: profile.color, badge: profile.badge,
    }),
  });
}

function renderAuthUI() {
  const signedIn = !!account;
  // Profile screen auth box
  $("googleSignIn").hidden = signedIn;
  $("authHint").hidden = signedIn;
  $("authSignedIn").hidden = !signedIn;
  if (signedIn) {
    $("authName").textContent = account.name || "Signed in";
    $("authEmail").textContent = account.email || "";
    if (account.picture) $("authPic").src = account.picture;
  }
  $("authBox").hidden = !identityApi; // no identity API on the dev http page
  // Lobby gate: creating/joining a room requires signing in.
  $("lobbyAuth").hidden = signedIn;
  $("lobbyControls").hidden = !signedIn;
  updateLobbyButtons();
}

// A Web-application OAuth client id, used with launchWebAuthFlow so sign-in
// works in Brave/Edge/Vivaldi as well as Chrome (getAuthToken is Chrome-only).
// Only the CLIENT ID goes here — never the client secret (this is a public
// client). Overridable at runtime via localStorage "wp-webclient".
const DEFAULT_WEB_CLIENT_ID = "570897047586-obh6j98a93u8fkbftdlvl49eahvp61tn.apps.googleusercontent.com";
const WEB_CLIENT_ID = store.get("wp-webclient") || DEFAULT_WEB_CLIENT_ID;

function signInFail(msg) {
  addSystem("Google sign-in failed: " + msg);
  setNote("Sign-in failed: " + msg);
  console.warn("[watchparty] sign-in error:", msg);
  $("googleSignIn").disabled = false;
  $("lobbySignIn").disabled = false;
}

// Finish sign-in once we have an access token: fetch the profile, store it,
// and sync with the backend.
async function completeSignIn(token) {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + token },
    });
    const info = await res.json();
    if (!info.sub) return signInFail("couldn't read Google profile");
    account = {
      sub: String(info.sub),
      email: String(info.email || ""),
      name: String(info.name || info.given_name || ""),
      picture: String(info.picture || ""),
      token,
    };
    store.set("wp-account", JSON.stringify(account));
    myUid = computeUid();
    if (!profile.name && account.name) profile.name = account.name.slice(0, 20);
    saveProfile();
    renderAuthUI();
    renderProfileUI();
    addSystem(`Signed in as ${account.name || account.email}.`);
    const server = await backendFetch("/auth", { method: "POST" });
    if (server) { applyServerProfile(server); renderAuthUI(); }
    broadcast(profileMsg("hello"));
  } catch {
    signInFail("couldn't read Google profile — try again");
  }
}

function signInWithGoogle() {
  if (!identityApi) {
    setNote("Google sign-in needs the installed extension (not the dev page).");
    return;
  }
  $("googleSignIn").disabled = true;
  $("lobbySignIn").disabled = true;

  // launchWebAuthFlow works in every Chromium browser (Brave included). Prefer
  // it whenever a Web client id is configured.
  if (WEB_CLIENT_ID) {
    const redirectUri = identityApi.getRedirectURL();
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: WEB_CLIENT_ID,
        response_type: "token",
        redirect_uri: redirectUri,
        scope: "openid email profile",
        prompt: "select_account",
      }).toString();
    identityApi.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      const err = globalThis.chrome?.runtime?.lastError;
      if (err || !responseUrl) return signInFail(err?.message || "cancelled");
      let token = "";
      try { token = new URLSearchParams(new URL(responseUrl).hash.slice(1)).get("access_token") || ""; } catch {}
      if (!token) return signInFail("no access token returned");
      completeSignIn(token);
    });
    return;
  }

  // Fallback: Chrome-only getAuthToken (no Web client configured).
  identityApi.getAuthToken({ interactive: true }, (token) => {
    const err = globalThis.chrome?.runtime?.lastError;
    if (err || !token) {
      return signInFail((err?.message || "cancelled") + " — Brave/Edge need a Web client (see setup).");
    }
    completeSignIn(token);
  });
}

function signOutGoogle() {
  const token = account?.token;
  account = null;
  store.del("wp-account");
  myUid = computeUid();
  renderAuthUI();
  if (token && identityApi) {
    try { identityApi.removeCachedAuthToken({ token }, () => {}); } catch {}
    fetch("https://accounts.google.com/o/oauth2/revoke?token=" + token).catch(() => {});
  }
  addSystem("Signed out.");
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
  $("googleSignIn").addEventListener("click", signInWithGoogle);
  $("lobbySignIn").addEventListener("click", signInWithGoogle);
  $("googleSignOut").addEventListener("click", signOutGoogle);
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

const NO_VIDEO_HINT = "Tip: open something to watch — whatever you play here plays for everyone in your room.";

function updateLobbyButtons() {
  const hasName = !!$("nameInput").value.trim();
  // Must be signed in to create or join a room, and have a name.
  const ready = hasName && !!account;
  $("createBtn").disabled = !ready;
  $("joinBtn").disabled = !ready;
  if (state.view === "lobby" && FRAMED) {
    const hasVideo = state.pageVideo;
    if (!hasVideo && ($("note").hidden || $("note").textContent === NO_VIDEO_HINT)) {
      $("note").className = "note hint-note";
      setNote(NO_VIDEO_HINT);
    } else if (hasVideo && $("note").textContent === NO_VIDEO_HINT) {
      $("note").className = "note";
      setNote("");
    }
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
      if (typeof d.href === "string") state.pageHref = d.href;
      if (state.pageVideo) {
        state.lastVideo = { paused: !!d.paused, time: Number(d.time) || 0, at: Date.now() };
      }
      updateLobbyButtons();
      shareMyVideo(); // if I hold the remote, broadcast this watch URL
      // A follower compares the controller's reported position against its own.
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

  // Any user interaction resumes the audio graph (autoplay policy may suspend
  // it). Capture phase so nothing can swallow it first.
  ["click", "keydown", "pointerdown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, resumeAudio, true)
  );
}

async function init() {
  if (typeof Peer === "undefined") {
    setStatus("err", "PeerJS missing");
    setNote("lib/peerjs.min.js failed to load — reinstall the extension.");
    return;
  }
  wire();
  renderProfileUI();
  renderAuthUI();
  setStatus("", "Off air");
  // If signed in, pull the latest profile from the account so edits made on
  // another device show up here.
  if (account && BACKEND_URL) {
    backendFetch("/profile").then((p) => { if (p) { applyServerProfile(p); renderAuthUI(); } });
  }
  // This is the moment the browser asks for camera/mic permission — right when
  // the sidebar opens on Netflix/YouTube/Prime/anywhere.
  await ensureStream();
  queryPageVideo();

  // Keep watching the page's video: gates the lobby until one is selected,
  // and keeps the controller's position fresh for join-state and drift ticks.
  if (FRAMED) setInterval(queryPageVideo, 4000);
  setInterval(() => {
    if (iAmController() && state.room && FRAMED) {
      const lv = latestVideoState();
      if (lv) broadcast({ type: "sync-tick", time: lv.time, paused: lv.paused, uid: myUid });
    }
    // Keep the driving rejoin fresh so it never expires between navigations.
    persistRejoinIfDriving();
  }, 8000);

  // Auto-rejoin after the page navigated to the host's video (content script
  // re-opened the sidebar with ?rejoin once it saw a stored session).
  const rejoin = params.get("rejoin");
  const join = params.get("join");
  if (rejoin && profile.name) {
    if (params.get("role") === "host") rehostRoom(rejoin);
    else joinRoom(rejoin, 1);
  } else if (params.get("create") === "1" && profile.name) {
    createRoom();
  } else if (join) {
    $("joinInput").value = join;
    if (profile.name) joinRoom(join);
    else setNote("Enter your name, then press Join.");
  }
}

document.addEventListener("DOMContentLoaded", init);
