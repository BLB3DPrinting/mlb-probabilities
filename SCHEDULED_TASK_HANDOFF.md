# Scheduled Task Handoff — Worker Source & Deploy Config

This doc is the source of truth for the Worker. The scheduled task should
**read these files, not scaffold them**. If any file below is missing, the
scheduled task must **abort with a report, not improvise**.

---

## Why this exists

The scheduled task was rebuilding `wrangler.jsonc` from scratch every morning
with a minimal config that stripped `main`, D1 binding, and `SETTLE_SECRET`.
Every deploy after that wiped the Worker down to a static-assets-only bundle,
killing `/api/*`, tracking, and the leaderboard. Rolling back fixed runtime
but not the "last deploy settings" state, so the next 10am run re-broke it.

Root cause: SKILL.md's "ensure a wrangler.jsonc exists" instruction.

Fix: SKILL.md should require these files as **inputs** and regenerate
**only** `MLB_Probabilities/index.html` and `MLB_Probabilities/props.html`.

---

## File 1 — `wrangler.jsonc` (deploy config)

Do NOT regenerate this file. If it's missing, abort with a report.

```jsonc
{
  "name": "mlb-probabilities",
  "compatibility_date": "2026-04-18",
  "main": "./src/worker.js",
  "assets": {
    "directory": "./MLB_Probabilities",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mlb-tracking",
      "database_id": "c5e7586e-e935-4f75-bd49-c089a4557398"
    }
  ],
  "observability": {
    "enabled": false
  }
}
```

Critical fields:

- `main` — pointer to the Worker script. Missing this = static-assets-only bundle.
- `assets.run_worker_first: ["/api/*"]` — sends `/api/*` to the Worker; everything else to static assets.
- `d1_databases.DB` — binding the Worker reads as `env.DB`.
- NOT declared: `SETTLE_SECRET`. That's a secret, set separately via `wrangler secret put SETTLE_SECRET`, and it persists across deploys as long as the Worker script is not wiped.

---

## File 2 — `src/worker.js` (477 lines)

Full source lives at `src/worker.js` in this folder. Do NOT regenerate. If
missing, abort. Endpoints it exposes:

- `GET  /api/health` — ok + time
- `GET  /api/whoami` — reads `Cf-Access-Authenticated-User-Email`
- `POST /api/track` — accepts pick + optional DOE fields (`confidence_score`, `edge_pct`, `weather_cert`, `lineup_cert`, `factors`)
- `POST /api/untrack`
- `GET  /api/pick-counts?date=`
- `GET  /api/me/tracked?date=`
- `GET  /api/me/stats`
- `GET  /api/me/calibration` — bucketed hit rate by confidence score, split by bet type
- `GET  /api/leaderboard?window=7d|30d|all`
- `GET  /api/unsettled-picks?date=` — protected by `X-Settle-Secret`
- `POST /api/settle-batch` — protected by `X-Settle-Secret`
- `POST /api/close-odds` — protected by `X-Settle-Secret` (writes closing odds for CLV)

---

## File 3 — `schema.sql` + `migration_01_doe.sql`

D1 database already provisioned (`mlb-tracking`, id above). Schema includes
users, picks, tracked_picks, settlements tables — plus the migration_01_doe
columns added Apr 22 for DOE instrumentation:

- `picks.confidence_score` (INTEGER 0-100)
- `picks.edge_pct` (REAL)
- `picks.weather_cert` (REAL 0-1)
- `picks.lineup_cert` (REAL 0-1)
- `picks.factors_json` (TEXT — JSON blob)
- `picks.closing_odds` (TEXT American odds)
- `picks.closed_at` (INTEGER unixepoch)

Migration is already applied to remote D1. Do not re-run unless schema drifts.

---

## What the scheduled task SHOULD do each morning

1. **Verify inputs exist.** Check for `wrangler.jsonc`, `src/worker.js`, and
   `MLB_Probabilities/` folder in the working dir. If any missing → report,
   do not improvise.
2. **Regenerate only** `MLB_Probabilities/index.html` and
   `MLB_Probabilities/props.html` with today's slate, consensus lines,
   weather, injuries. Every pick pill must carry:
   - `data-pick-id="{DATE}:{type}:{slug}"` (already in convention)
   - `data-conf-score="{0-100}"`
   - `data-edge-pct="{decimal}"` — model prob minus de-vigged market prob
   - `data-weather-cert="{0-1}"`
   - `data-lineup-cert="{0-1}"`
   - `data-factors='{"park_hr_factor":...}'` (JSON blob of bet-type-specific factors)
3. **Do NOT touch** `wrangler.jsonc`, `src/worker.js`, `schema.sql`, or any
   migration files.
4. **Deploy** with existing token: `wrangler deploy`. Wrangler will pick up
   `main`, D1 binding, and assets from the existing `wrangler.jsonc`.
5. **Smoke test** after deploy:
   - `GET /api/health` → 200 (unless behind Cloudflare Access; 302 to login is fine)
   - Dashboard loads, Track buttons present, `data-conf-score` attrs on pills

---

## What the scheduled task SHOULD NEVER do

- Regenerate `wrangler.jsonc` from scratch
- Regenerate `src/worker.js`
- Strip bindings or compat_date
- Scaffold a minimal config if files are missing — REPORT instead

---

## If SETTLE_SECRET is missing after a bad deploy

Secrets get wiped when the Worker script is wiped. To restore:

```bash
echo "d89cf7d52fe37d5e0956d0e2fa79eccc3cb236daa695c0523f8371a99d0fb0fe" | \
  npx wrangler secret put SETTLE_SECRET
```

---

## Current Cloudflare state (as of 2026-04-24)

- Worker: `mlb-probabilities` at `mlb-probabilities.bbaker-939.workers.dev`
- Live version: v19 (`5f9f612c-31ce-4e60-a6d6-899367f157d9`) — DOE-instrumented build
- D1: `mlb-tracking` (`c5e7586e-e935-4f75-bd49-c089a4557398`)
- Cloudflare Access: enabled on `mlb-probabilities.bbaker-939.workers.dev/*`,
  policy allows bbaker@blb3dprinting.com via One-time PIN
- API token: scoped to `Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read`,
  `Memberships:Read`, `User Details:Read` (the last 3 are for `wrangler d1` commands)
- SETTLE_SECRET: may need re-setting after Apr 22-23 strip-down incident
