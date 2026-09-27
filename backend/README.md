# WatchParty backend

Google-verified auth + profile sync for the WatchParty extension, storing users
in MongoDB Atlas. Deploys to Railway.

## What it does

- Validates the Google access token the extension sends (confirming it was
  issued for your OAuth client), so only your extension's users can write.
- Stores each user's profile (name, avatar, color, badge) keyed by their Google
  user id, so the same identity/profile follows them across devices.

## API

| Method | Path       | Auth                         | Purpose |
|--------|------------|------------------------------|---------|
| GET    | `/health`  | none                         | Liveness check |
| POST   | `/auth`    | `Authorization: Bearer <token>` | Sign in / create the user, returns profile |
| GET    | `/profile` | `Authorization: Bearer <token>` | Read profile |
| PUT    | `/profile` | `Authorization: Bearer <token>` | Update profile (name/avatar/color/badge) |

## MongoDB

Database `watchparty`, collection `users`:

```
{ _id: "<google sub>", email, name, avatar, color, badge, createdAt, updatedAt }
```

The collection and index are created automatically on first run — you only need
an empty cluster and a database user.

## Deploy on Railway

1. **MongoDB Atlas connection string:** Atlas → your cluster → **Connect** →
   **Drivers** → copy the `mongodb+srv://…` string. Replace `<password>` with
   your database user's password and put `watchparty` as the database name.
   In Atlas **Network Access**, allow `0.0.0.0/0` (Railway's IPs are dynamic).
2. **Railway service → Variables**, add:
   - `MONGODB_URI` = the connection string above
   - `GOOGLE_CLIENT_ID` = `570897047586-b71eq79nrrrln298h2kjctpi27o3se48.apps.googleusercontent.com`
   - `DB_NAME` = `watchparty` (optional)
   - Do **not** set `PORT` — Railway provides it.
3. **Root directory:** point the Railway service at this `backend/` folder
   (Settings → Root Directory = `backend`). Railway auto-detects Node and runs
   `npm start`.
4. Deploy. Railway gives you a public URL like
   `https://watchparty-backend-production.up.railway.app`.
5. Put that URL in the extension: set `BACKEND_URL` at the top of
   `sidebar/sidebar.js` (or the "Sync server" field in the panel's Settings).

## Local run

```bash
cd backend
npm install
MONGODB_URI="mongodb+srv://…/watchparty" npm start
```
