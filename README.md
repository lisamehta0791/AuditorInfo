# AuditLens

A register for tracking which CA (Chartered Accountant) firms and partners
audit which listed companies, for which financial year, and for how long —
built to support ICAI/SEBI-style compliance tracking such as auditor
rotation limits, data-quality gaps, and market-concentration reporting.

Core entities: **Companies**, **CA Firms**, **CA Members (partners)**, and
**Audit Records** (an appointment of a firm+partner to sign a company's
report for a given financial year — a report can have multiple co-signing
auditors). Firms and members are additionally linked over time through
**Partner Records** (firm–member relationship history).

## Tech stack

- **Backend**: Node.js + Express 5, MySQL (via `mysql2`), Server-Sent Events
  for live updates across open tabs. No authentication layer — see
  `backend/src/middleware/auth.js`.
- **Frontend**: a single static HTML file (`frontend/index.html`) — vanilla
  JavaScript, no framework and no build step. It talks to the backend over
  a plain `fetch`-based API client.
- **Database**: MySQL.

## Prerequisites

- Node.js 18+
- A MySQL database already provisioned with this project's schema

## Setup

1. Install backend dependencies:
   ```
   cd backend
   npm install
   ```
2. Create `backend/.env` with:
   ```
   DB_HOST=
   DB_PORT=
   DB_USER=
   DB_PASS=
   DB_NAME=
   PORT=3001
   FRONTEND_ORIGIN=            # optional — origin of a hosted frontend, if any
   COOKIE_SECRET=              # any random string
   JWT_SECRET=                 # reserved for future use — no auth is currently enforced
   JWT_EXPIRES=
   ```

## Running it

**Backend** (from `backend/`):
```
npm run dev     # nodemon, auto-restarts on change
npm start       # plain node
```
Starts the API on `http://localhost:3001` (or `PORT` from `.env`) and logs
`✓ MySQL connected` once the database is reachable.

**Frontend**: `frontend/index.html` is a static file with no build step —
open it directly in a browser, or serve it with any static file server /
the VS Code "Live Server" extension. It calls the API at the hardcoded
`http://localhost:3001/api` (see the `API` constant near the top of the
`<script>` block), so the backend must be running first.

## Project structure

```
backend/
  src/
    app.js              — Express app: middleware, route mounting, error handler
    config/db.js         — MySQL connection pool
    middleware/auth.js    — currently a no-op (no auth enforced)
    routes/               — one file per resource (companies, firms, members,
                             appointments, dq, alerts, analytics, fy, sectors, events)
    events.js             — SSE broadcast hub used by routes to push live updates
frontend/
  index.html             — the entire UI: styles, markup, and app logic in one file
```
