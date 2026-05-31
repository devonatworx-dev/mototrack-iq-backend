# MotoTrackIQ Backend v2 — README

**Version:** 2.0 | **Built:** April 2026 | **Backend:** `192.168.1.77:3013` | **Portal:** `192.168.1.77:3015`

---

## Overview

MotoTrackIQ Backend v2 is a REST API server for the MotoTrackIQ v2 portal. It handles rider authentication, session management, CSV upload and analysis, beta signup, and admin operations. Built with Node.js (ES modules), Express, and SQLite via `sql.js`.

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
| POST | `/api/auth/register` | Register new rider |
| POST | `/api/auth/login` | Login, returns JWT |
| POST | `/api/auth/forgot-password` | Send reset email |
| POST | `/api/auth/reset-password` | Reset with token |
| POST | `/api/auth/change-password` | Change password (requires JWT) |
| GET | `/api/auth/me` | Get current user |

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
| POST | `/api/analyze` | Upload CSV and get lap analysis (public, no auth) |
| GET | `/api/sessions/:id/analysis` | Get analysis for a session (auth required) |

### Beta
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/beta/signup` | Join beta waitlist |
| GET | `/api/beta/stats` | Get beta signup stats |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/riders` | List all riders (auth required) |
| GET | `/api/admin/analytics` | Platform analytics (auth required) |

### Health
| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check |

---

## Database

**Location:** `/home/assistant/.openclaw/workspace/mototrack-iq-backend-v2/database.sqlite`

**Schema:**
- `riders` — id, email, name, password_hash, created_at
- `sessions` — id, rider_id, date, track, laps_count, top_speed, best_lap, file_name, status
- `beta_signups` — id, email, name, created_at

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
| `PORT` | Server port (default: 3013) |
| `JWT_SECRET` | Secret for JWT signing |
| `FRONTEND_URL` | CORS origin (default: `http://192.168.1.77:3015`) |
| `GMAIL_CLIENT_ID` | OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | OAuth2 refresh token |

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

---

*Last updated: 2026-04-22 — Devon AI Assistant*