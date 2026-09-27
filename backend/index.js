// WatchParty backend — Google-verified auth + profile sync on MongoDB Atlas.
//
// The extension signs in with Google (chrome.identity) and sends the resulting
// access token in `Authorization: Bearer <token>`. This server validates the
// token with Google (checking it was issued for OUR OAuth client), then reads
// and writes that user's profile in MongoDB, keyed by their Google user id.
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import fs from "fs";

// Load a local .env for development (gitignored). Existing env vars — e.g.
// Railway's own Variables in production — always win.
try {
  const text = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#") && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "watchparty";
// Accept tokens issued for either of our OAuth clients: the Web client (used by
// launchWebAuthFlow in Brave/Edge/Chrome) and the Chrome-extension client (used
// by getAuthToken on Chrome). GOOGLE_CLIENT_ID may be a comma-separated list.
const GOOGLE_CLIENT_IDS = (
  process.env.GOOGLE_CLIENT_ID ||
  "570897047586-obh6j98a93u8fkbftdlvl49eahvp61tn.apps.googleusercontent.com," +
    "570897047586-b71eq79nrrrln298h2kjctpi27o3se48.apps.googleusercontent.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors()); // extension pages fetch cross-origin; allow it
app.use(express.json({ limit: "16kb" }));

let users = null;
let dbError = "";

async function init() {
  if (!MONGODB_URI) { dbError = "MONGODB_URI is not set"; console.error(dbError); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    await client.db(DB_NAME).command({ ping: 1 });
    users = client.db(DB_NAME).collection("users");
    await users.createIndex({ email: 1 });
    dbError = "";
    console.log("Connected to MongoDB (db:", DB_NAME + ")");
  } catch (e) {
    dbError = String(e && e.message || e);
    // Common cause: Atlas Network Access hasn't allowed 0.0.0.0/0 for Railway.
    console.error("MongoDB connection FAILED:", dbError);
    console.error("If this is a timeout, allow 0.0.0.0/0 in Atlas → Network Access.");
    setTimeout(init, 10000); // keep retrying so it recovers once Atlas is opened
  }
}

// Endpoints that need the DB return 503 until it's connected.
function requireDb(res) {
  if (!users) { res.status(503).json({ error: "database not ready", detail: dbError }); return false; }
  return true;
}

// Validate the Google access token and return the caller's identity, or null.
async function verify(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  try {
    // tokeninfo confirms the token is valid AND was issued for our client.
    const ti = await fetch(
      "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=" + encodeURIComponent(token)
    );
    if (!ti.ok) return null;
    const info = await ti.json();
    const aud = info.aud || info.azp;
    if (!GOOGLE_CLIENT_IDS.includes(aud)) return null;
    // userinfo gives the display name and picture.
    const ui = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + token },
    });
    const profile = ui.ok ? await ui.json() : {};
    const sub = info.sub || profile.sub;
    if (!sub) return null;
    return {
      sub: String(sub),
      email: profile.email || info.email || "",
      name: profile.name || profile.given_name || "",
      picture: profile.picture || "",
    };
  } catch {
    return null;
  }
}

const publicProfile = (u) => ({
  id: u._id,
  email: u.email || "",
  name: u.name || "",
  avatar: u.avatar || "🍿",
  color: u.color || "",
  badge: u.badge || "",
});

app.get("/health", (_req, res) => res.json({ ok: true, db: !!users, dbError: dbError || undefined }));

// Sign in: upsert the user and return their stored profile (created on first
// sign-in from their Google name).
app.post("/auth", async (req, res) => {
  if (!requireDb(res)) return;
  const g = await verify(req);
  if (!g) return res.status(401).json({ error: "unauthorized" });
  const now = new Date();
  const existing = await users.findOne({ _id: g.sub });
  if (!existing) {
    const doc = {
      _id: g.sub,
      email: g.email,
      name: (g.name || "").slice(0, 20),
      avatar: "🍿",
      color: "",
      badge: "",
      createdAt: now,
      updatedAt: now,
    };
    await users.insertOne(doc);
    return res.json(publicProfile(doc));
  }
  await users.updateOne({ _id: g.sub }, { $set: { email: g.email, updatedAt: now } });
  res.json(publicProfile({ ...existing, email: g.email }));
});

// Read the signed-in user's profile.
app.get("/profile", async (req, res) => {
  if (!requireDb(res)) return;
  const g = await verify(req);
  if (!g) return res.status(401).json({ error: "unauthorized" });
  const u = await users.findOne({ _id: g.sub });
  res.json(u ? publicProfile(u) : null);
});

// Update the signed-in user's profile.
app.put("/profile", async (req, res) => {
  if (!requireDb(res)) return;
  const g = await verify(req);
  if (!g) return res.status(401).json({ error: "unauthorized" });
  const b = req.body || {};
  const set = { updatedAt: new Date() };
  if (typeof b.name === "string") set.name = b.name.slice(0, 20);
  if (typeof b.avatar === "string") set.avatar = b.avatar.slice(0, 8);
  if (typeof b.color === "string") set.color = b.color.slice(0, 16);
  if (typeof b.badge === "string") set.badge = b.badge.slice(0, 8);
  await users.updateOne(
    { _id: g.sub },
    { $set: set, $setOnInsert: { email: g.email, createdAt: new Date() } },
    { upsert: true }
  );
  const u = await users.findOne({ _id: g.sub });
  res.json(publicProfile(u));
});

// Start the web server FIRST so Railway's health check passes even while the
// DB is still connecting; then connect to Mongo (with retries) in the
// background. This turns a DB outage into a 503 on data routes instead of a
// dead service that never boots.
app.listen(PORT, () => console.log("WatchParty backend listening on " + PORT));
init();
