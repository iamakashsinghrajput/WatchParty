# WatchParty — Watch Together

A cross-browser (Manifest V3) extension that adds a right-side companion column to
Netflix, YouTube, Prime Video — or any page. Two people join the same room code and
get **camera-to-camera video** and **text chat** side by side with whatever they're
watching or working on.

## How it works

```
┌──────────────────────────────┬─────────────┐
│                              │  🎥 friend  │
│        netflix.com           │  (your cam  │
│   (page shifted 340px left)  │   in a PiP) │
│                              ├─────────────┤
│                              │  💬 chat    │
│                              │  [message…] │
└──────────────────────────────┴─────────────┘
```

- `content.js` injects an **extension-page iframe** (`sidebar/sidebar.html`) pinned to
  the right edge and shifts the page over (`html { margin-right: 340px }`), plus a
  red-accented toggle handle on the edge of every page. The sidebar **auto-opens on streaming sites**
  (Netflix, YouTube, Prime Video, Disney+, Hotstar, Hulu, Max) and opens on demand
  everywhere else (toolbar button or the edge handle).
- Because the sidebar is an extension page, camera/microphone permission is asked
  **once for the extension** and then works on every site — and the page's own CSP
  can't block it.
- Signaling goes through the free **PeerJS cloud**; video/audio/chat flow
  **peer-to-peer over WebRTC** (nothing is routed through a server you have to run).
- If the camera is blocked/missing, the sidebar falls back to a generated avatar
  stream so the room, chat, and the video pipeline still work; the camera button
  retries the real camera mid-call (`RTCRtpSender.replaceTrack`).

## Install

**Chrome / Edge / Brave / Opera**
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`watchparty-extension`).

**Firefox** (temporary add-on)
1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json`.
3. Firefox treats MV3 host permissions as opt-in: enable site access for the
   extension in `about:addons` → WatchParty → Permissions.

**Safari**: convert with `xcrun safari-web-extension-converter .` (needs Xcode).

## Use

1. Open Netflix / YouTube / Prime — the sidebar slides in and asks for your camera.
2. Click **Create a room**, hit **Copy**, and send the code to your friend.
3. Your friend opens any video (or any page), clicks the WatchParty handle, pastes the code,
   and hits **Join**.
4. You see and hear each other in the panel and chat underneath while the video
   plays. The camera and mic buttons toggle your video and audio; **Leave** ends
   the call; the close button hides the panel (an active call keeps running so
   you can still hear each other).

## Development / testing

The sidebar also runs standalone (that's how it was tested end-to-end):

```bash
python3 -m http.server 8765 --directory .
# two browser tabs:
#   http://localhost:8765/sidebar/sidebar.html?fake=1            → Create a room
#   http://localhost:8765/sidebar/sidebar.html?fake=1&join=CODE  → joins it
```

URL params: `fake=1` (avatar stream instead of camera — no permission prompt),
`name=X`, `create=1`, `join=CODE`, and `host`/`port`/`path`/`secure` to point at a
self-hosted PeerServer (`npx peerjs --port 9000`) instead of the PeerJS cloud.
`test/movie.html` is a fake streaming page for layout testing.

## v2 highlights

- **Up to 6 people per room.** Rooms are a full WebRTC mesh: the room creator
  introduces each newcomer to everyone already there (`roster` message), then
  they all connect directly. Everyone gets a tile in the video grid; chat is
  broadcast to the whole room.
- **Playback sync.** The link button in the room bar syncs the page's video:
  play, pause, and seek follow everyone who has sync turned on (the content
  script drives the site's `<video>` element; works on YouTube/Prime/most
  sites — Netflix accepts play/pause but fights external seeking).
- **Cam/mic can turn on mid-call, no re-joining.** Every call starts with both
  a video track and an audio track — placeholders (an avatar canvas and a
  silent audio track) when permission is missing — so enabling the real camera
  or mic later is a plain `RTCRtpSender.replaceTrack`, no renegotiation.
- **Configurable signaling.** Gear icon → set your own PeerServer (host, port,
  path, TLS); the `server/` folder has a ready-to-run setup (`npx peerjs`,
  npm, or Docker). Left empty, the free PeerJS cloud is used.
- **Pop-out window.** The window button opens the party in its own always-on-top-able
  window — handy for fullscreen playback or a second monitor; it rejoins the
  same room automatically.
- **Names are required** — create/join stay disabled until you enter one, and
  it's remembered for next time.

## v2.1 — party UI

- **Profiles** (avatar button in the header): emoji avatar, display name, name
  color, and a chat badge, with a live chat preview. Changes propagate to the
  room instantly.
- **Feed-style chat**: avatar + colored name + timestamp, with grouped
  continuation rows, and playback events in the feed ("created the party 🎉",
  "joined the party", "started playing the video", "paused the video",
  "jumped to 1:23:45").
- **Quick reactions** (🥰 😡 😭 😂 🤯 🔥) float up over the video tiles for
  everyone in the room; an emoji picker sits in the composer.
- **Camera/mic setup** (sliders icon in the composer): pick your camera and
  microphone from device dropdowns with a live preview; applies to the call
  instantly via `replaceTrack`.
- **Mirrored self-view**: your own camera is flipped like a mirror (remote
  video is never flipped).

## Remaining notes

- The room code belongs to the room's creator: if they leave, people already
  in the room stay connected to each other, but new people can't join with
  that code.
- Behind very strict NATs you may need a TURN server (see `server/README.md`).
