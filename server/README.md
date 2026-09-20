# WatchParty signaling server (self-hosted)

By default WatchParty uses the free PeerJS cloud for signaling (only the
handshake goes through it — video, audio, and chat are peer-to-peer). For
production, or if the cloud is unreachable, run your own PeerServer:

```bash
# one-off, no install
npx peerjs --port 9000 --path /

# or from this folder
npm install
npm start

# or Docker
docker run -p 9000:9000 -d peerjs/peerjs-server
```

Then in the extension: gear icon → **Signaling server** → host (e.g.
`signal.example.com` or `localhost`), port `9000`, path `/`, and tick **TLS**
if the server is behind HTTPS. Every participant must point at the same server.
The setting is stored once for the extension and applies on every site.

For internet use, put PeerServer behind a TLS reverse proxy (Caddy/nginx) and
enable the TLS checkbox. If participants are behind strict NATs, add a TURN
server (e.g. coturn) — PeerJS accepts a custom `config.iceServers`; see
`peerOpts()` in `sidebar/sidebar.js`.
