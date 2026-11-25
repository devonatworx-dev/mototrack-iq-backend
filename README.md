# MotoTrackIQ Backend v2 — README

**Version:** 2.0 | **Built:** April 2026 | **Backend:** `192.168.1.77:3013` | **Portal:** `192.168.1.77:3015`

---

## Overview

MotoTrackIQ Backend v2 is a REST API server for the MotoTrackIQ portal. Riders sign up directly (email/password, Google, Microsoft) and upload their own session files. Built with Node.js (ES modules), Express, and SQLite via `sql.js`. The waitlist HTTP routes and the ESP32 bridge are retired. Existing `beta_signups` and `sessions` rows, including older bridge captures, stay in the database.

---

## Quick Start

```bash
# Start backend
cd /home/assistant/.openclaw/workspace/mototrack-iq-backend-v2
node server.js

# Or via PM2 (already registered)
pm2 start mototrackiq-backend-v2
pm2 logs mototrackiq-backend-v2
```

---

## Ports

| Service | Port | URL |
|---|---|---|
| Backend API | 3013 | `http://192.168.1.77:3013` |
| Frontend Portal | 3015 | `http://192.168.1.77:3015` |

---

## API Endpoints

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Register new rider. Optional `marketingConsent` boolean (default false). |
| POST | `/api/auth/login` | Login, returns JWT |
| POST | `/api/auth/forgot-password` | Send reset email |
| POST | `/api/auth/reset-password` | Reset with token |
| POST | `/api/auth/change-password` | Change password (requires JWT) |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/auth/oauth/:provider/start` | Start provider sign-in. `ontario=1` is required for a new account. `consent=1` is optional marketing consent, not a requirement and not Terms acceptance. |
| GET | `/api/email/unsubscribe?token=` | One-click marketing unsubscribe. POST accepts the same token (List-Unsubscribe-Post). |

### Marketing consent (CASL)

`POST /api/auth/register` accepts `marketingConsent`. A JSON boolean `true`, the number `1`, or the strings `"true"` and `"1"` opt in. Omitted, `false`, and every other value do not. The choice is stored on the rider (`marketingConsent`, `marketingConsentAt`, `marketingConsentSource`) and as a row in `marketing_consent_records` with source `register`. Confirming the email does not change it.

Provider start (`GET /api/auth/oauth/:provider/start`) still requires `ontario=1` for a new account. `consent=1` (or `consent=true`, or `marketingConsent=1`) means the marketing box was checked and is recorded with source `oauth`. Leaving it off still creates the account and records `marketingConsent` 0. Terms of Service and Privacy Policy acceptance is a separate portal checkbox. This API does not read it from `consent` or `marketingConsent`.

`GET /api/admin/riders` includes `marketingConsent`, `marketingConsentAt`, and `marketingConsentSource`. Commercial sends (beta invites, rider follow-ups, and the promotional block on a report) go only to addresses with `marketingConsent` 1. Verification, password reset, welcome, credentials, and the report itself do not. Legacy `beta_signups` rows are marked `marketingConsent` 0.

### Sessions
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/sessions` | List rider's sessions (auth required) |
| POST | `/api/sessions` | Create new session |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Delete session |

### Analysis
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/analyze` | Upload CSV and get lap analysis (rider JWT) |
| GET | `/api/sessions/:id/analysis` | Get analysis for a session (rider JWT) |
| GET | `/api/sessions/:id/report-link` | Mint a signed browser URL for an existing report (rider JWT, owner only) |
| GET | `/api/device/sessions/:id/report` | Download that PDF. Requires the signed `token` query from the link above, or the admin key. This is the only `/api/device` route. |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/riders` | List all riders, including marketing consent fields (admin key) |
| GET | `/api/admin/analytics` | Platform analytics (auth required) |
| GET | `/api/admin/backups` | List backup file names, sizes, and times (admin key). No file contents. |
| POST | `/api/admin/backups` | Write and verify one backup now (admin key). No file contents in the response. |

### Health
| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check |

---

## Database

The live database is one SQLite file, held in memory with `sql.js` and written through after each change.

**Live file:** `DB_PATH`, or `data/mototrackiq.db` inside this repo when `DB_PATH` is unset. On Railway, `DB_PATH` is a file on the volume mounted at `/data`.

**Saves:** each change writes a temp file in the same directory as `DB_PATH`, fsyncs it, and renames it over the live file. The live file is not written in place. A crash during a save leaves the previous file as it was. Leftover `*.tmp` files next to the database are incomplete saves. Leave them out of a restore.

**Backups:** on startup, once a day after that, and when an admin calls `POST /api/admin/backups`, the process copies the live file to `/data/backups/` (override with `BACKUP_DIR`). Names look like `mototrackiq-20261125T041030123Z.db`. Each copy is opened with `sql.js` and checked with `PRAGMA integrity_check` before it counts. A copy that fails that check is deleted. After a good copy, the process keeps the newest `BACKUP_RETENTION` backups (default 14) and deletes older files that match that name pattern. Anything else in the directory stays.

`GET /api/admin/backups` and `POST /api/admin/backups` require the admin key (`X-Admin-Key` or `Authorization: Bearer`). Both return the backup name, size in bytes, and modification time. They do not return database bytes. There is no download route.

The server opens `DB_PATH` only. It does not copy a file from the backup directory onto the live database at startup or on a timer.

### Restore a backup by hand

Do this yourself, with the process stopped. The running server keeps the database in memory and will overwrite `DB_PATH` from that memory on the next save, so replacing the file while the process is up does not restore anything.

1. In the Railway service variables, read `DB_PATH`. It needs to be a path on the volume, under `/data`. Read `BACKUP_DIR` too if it is set; otherwise backups are in `/data/backups`.
2. `GET /api/admin/backups` with the admin key and choose a name from that list. Or list `/data/backups` on the volume. Prefer a file the service wrote (the timestamped `mototrackiq-*.db` names). Do not restore a `*.tmp` file.
3. Stop the `mototrack-iq-backend` service so nothing is writing. Starting it again uses the same one replica. This procedure does not change the replica count, the builder, or any variable.
4. On the volume, keep the current live file, then replace it with the backup using a rename in the live file's directory (same filesystem as the volume):

```bash
# Set these from the Railway variables. Example live path shown.
DB_PATH=/data/mototrackiq.db
BACKUP=/data/backups/mototrackiq-20261125T041030123Z.db

cp -a "$DB_PATH" "${DB_PATH}.before-restore"
cp -a "$BACKUP" "${DB_PATH}.restore"
mv -f "${DB_PATH}.restore" "$DB_PATH"
```

5. Start the service. On boot it loads `$DB_PATH` and leaves `/data/backups` as it is. It also writes a new startup backup of whatever it just loaded.
6. Check `GET /health` and a rider or session you expect to see in that backup. If the backup was the wrong one, stop the service again and repeat the rename using `${DB_PATH}.before-restore` or a different file in `/data/backups`.

There is no automatic restore. A bad or missing live file does not cause the process to pick an older backup.

---

## Gmail OAuth2 Setup

The backend sends emails via the Gmail API using OAuth2 refresh tokens.

**Setup:**
1. Copy token from `workspace/pocs/lead-followup/src/config/token.json` to `workspace/mototrack-iq-backend-v2/config/token.json`
2. Or re-authorize via `scripts/google-auth.js` in the lead-followup folder
3. Env vars needed: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URIS`

**Email templates:** `lib/email.js` — welcome email, password reset

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3009) |
| `JWT_SECRET` | Required. Secret for rider JWTs. No default. |
| `FRONTEND_URL` | Portal origin used in email links |
| `API_PUBLIC_URL` | Public origin of this API. Unsubscribe links use it, then `FRONTEND_URL`. |
| `BUSINESS_MAILING_ADDRESS` | Optional. Physical address on commercial email. Unset shows `[Mailing address coming soon]` and logs a warning. |
| `UNSUBSCRIBE_SECRET` | Optional HMAC for unsubscribe links. Falls back to `REPORT_LINK_SECRET`, then `JWT_SECRET`. Does not change `JWT_SECRET`. |
| `GOOGLE_CLIENT_ID` | Gmail API client id (sender). Not the sign-in client. |
| `GOOGLE_CLIENT_SECRET` | Gmail API client secret |
| `GOOGLE_REFRESH_TOKEN` | Gmail API refresh token |
| `AUTH_RATE_LIMIT_MAX` | Per-IP cap for auth routes. Default `8`, clamped to 1–40. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | Per-IP window. Default `900000` (15 minutes). |
| `AUTH_EMAIL_MAX` | Per-mailbox cap for register, resend, and forgot-password. Default `5`, clamped to 1–20. |
| `AUTH_EMAIL_WINDOW_MS` | Per-mailbox window. Default `3600000` (1 hour). |
| `AUTH_EMAIL_COOLDOWN_MS` | Minimum gap between mail to the same address. Default `60000`. `0` turns off only the gap. |
| `DB_PATH` | Live SQLite file. Default `data/mototrackiq.db`. On Railway this is a file on the `/data` volume. |
| `BACKUP_DIR` | Backup directory. Default `/data/backups`. Optional. |
| `BACKUP_RETENTION` | How many verified backups to keep. Default `14`. Optional. Any value that is not a positive integer uses `14`. |

None of the `AUTH_*` variables are required. The server boots with the defaults. There is no device-ingest token. `BACKUP_DIR` and `BACKUP_RETENTION` are optional; leave them unset in production unless you want a different directory or a different keep-count.

---

## Restart Commands

```bash
pm2 restart mototrackiq-backend-v2     # Restart backend
pm2 restart mototrackiq-portal-v2       # Restart portal
pm2 logs mototrackiq-backend-v2 --lines 50  # View logs
pm2 status                              # Check all services
```

---

## Troubleshooting

**CSV analysis returns 400:**
- Check CSV format matches expected RaceBox/HTC format
- Required columns: `Lap`, `Time`, `Speed`

**Gmail emails not sending:**
- Verify `config/token.json` exists and is valid
- Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars
- Token may have expired — refresh at `localhost:3001` via lead-followup auth flow

**Database locked:**
- sql.js uses in-memory SQLite; no external locking issues
- If stuck, restart the PM2 process

**Need an older copy of the database:** follow "Restore a backup by hand" above. Stop the service first. The process will not roll back to a backup by itself.

---

*Last updated: 2026-04-22 — Devon AI Assistant*