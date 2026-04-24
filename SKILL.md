---
name: mlb-daily-probabilities
description: Regenerates today's MLB picks HTML and deploys to Cloudflare Workers. Does NOT rebuild wrangler.jsonc, src/worker.js, schema.sql, or any migrations — those are inputs and must exist before running.
---

You are generating **only** `MLB_Probabilities/index.html` and `MLB_Probabilities/props.html` for today's MLB slate and deploying to Cloudflare Workers. You must not touch `wrangler.jsonc`, `src/worker.js`, `schema.sql`, or any migration file. If any required input is missing, abort and report — do not scaffold or improvise.

Background on why this skill is cautious: on 2026-04-22 a prior run regenerated `wrangler.jsonc` from scratch with a minimal assets-only config, which stripped the Worker's `main`, D1 binding, and secret. Every subsequent deploy wiped `/api/*`, tracking, leaderboard, and DOE instrumentation until a manual restore on 2026-04-24. Follow the rules below to the letter.

## STEP 0 — LOCATE INPUTS (ABORT IF MISSING)

The scheduled task harness places project files under `/sessions/*/mnt/uploads/`. Required inputs, checked in this order:

1. `uploads/wrangler.jsonc` — Worker deploy config (main + D1 + assets binding + `assets.run_worker_first: ["/api/*"]`)
2. `uploads/src/worker.js` — Worker source (~477 lines, handles `/api/*`)
3. `uploads/MLB_Probabilities/` — static asset directory containing `index.html`, `props.html`, `leaderboard.html`, `me.html`, and any other files

If any of those is missing, produce a short report that lists exactly what's missing and stop. Do not generate placeholder config. Do not deploy.

Copy all inputs into a writable working directory (`/sessions/*/mnt/outputs/work/`) and do all subsequent edits there. Do not modify the originals in `uploads/`.

Verify:
```bash
grep -q '"main"' work/wrangler.jsonc || abort "wrangler.jsonc missing main field"
grep -q '"d1_databases"' work/wrangler.jsonc || abort "wrangler.jsonc missing d1_databases"
grep -q '"run_worker_first"' work/wrangler.jsonc || abort "wrangler.jsonc missing run_worker_first routing"
test -s work/src/worker.js || abort "src/worker.js missing or empty"
```
If any check fails, report and stop.

## STEP 1 — RESEARCH TODAY'S SLATE
- MLB schedule, probable pitchers, late scratches
- Injury reports (IL moves, day-to-day questionables that affect lineups)
- Weather for outdoor parks (wind direction/speed, temp, precip)
- Consensus lines — FanDuel as anchor (moneylines, totals, F5, props: HR, hits, RBI, TB, SB, Ks)

## STEP 2 — BUILD PROBABILITIES
De-vig the FanDuel anchor to get implied probability. Adjust ±3–6pp based on:
- Pitcher handedness vs batter splits (L/R, wOBA, ISO)
- Recent form (last 15 games)
- Weather multipliers (wind out = +HR, cold/wind in = -HR)
- Park factors
- Bullpen fatigue / pen-burn

Pick edges ≥3pp over de-vigged line. Grade confidence:
- **High**: ≥6pp edge, strong multi-factor support
- **Medium**: 3–6pp edge, 2+ factors
- **Low**: edge present but fragile / variance-heavy

## STEP 3 — REGENERATE `work/MLB_Probabilities/index.html` AND `work/MLB_Probabilities/props.html` ONLY

Preserve everything else in `work/MLB_Probabilities/` exactly as-is. Do NOT touch `leaderboard.html`, `me.html`, `.assetsignore`, or any other file.

Use the existing HTML in `uploads/MLB_Probabilities/` as the structural template — preserve the CSS block, nav, theme, tooltip CSS+JS, updated-badge CSS, and any JS that hooks up Track buttons. Only the data content changes.

### STEP 3a — PICK PILL ATTRIBUTES (MANDATORY — THE TRACKING API DEPENDS ON THESE)

Every pick pill (`<div class="pill ...">`) must carry:
- `data-pick-id="{YYYY-MM-DD}:{type}:{game-slug}:{detail-slug}"` where type ∈ `ml`, `total`, `f5`, `prop`, `parlay`. Example: `2026-04-24:prop:HOU-NYY:yordan-alvarez:over-1-5-tb`
- `data-conf-score="{0-100}"` — integer model confidence (High tier 70-90, Med 55-70, Low 45-55)
- `data-edge-pct="{decimal}"` — model probability minus de-vigged market probability, as decimal (e.g. `0.065` for +6.5pp)
- `data-weather-cert="{0-1}"` — confidence in weather data (`1.0` for domes/predictable, `0.6` for unsettled)
- `data-lineup-cert="{0-1}"` — confidence that key batters/pitchers will play (`1.0` confirmed lineup, `0.7` probable, `0.4` questionable)
- `data-factors='{"park_hr_factor":1.08,"splits_edge_pp":4.2,"form_l15":0.320,...}'` — JSON blob of bet-type-specific factors. Escape quotes for HTML attribute.
- `data-reason="<plain-English one-paragraph explanation>"` — used by the existing tooltip CSS

Include `data-tip-side="left"` on right-column pills to avoid tooltip viewport overflow.

### STEP 3b — STAKE PILL AND UNIT SIZING
Straight plays: 1.00u baseline, scale 0.5–1.5u by confidence.
Parlays (combined American odds):
- +150 to +250 → 0.50u
- +250 to +500 → 0.25u
- +500 to +1000 → 0.10u
- HR-pair parlays (2 HR legs) → 0.10u fixed
- +1000 to +2500 → 0.05u
- > +2500 → 0.02u

Every pick renders `<span class="stake-pill">0.25u</span>`. Include a unit-guide legend block on both pages.

### STEP 3c — LAST-UPDATED BADGE
Top of each page: `<span class="updated-badge"><span class="dot"></span> {Day}, {Mon DD, YYYY} · {HH:MM} AM ET</span>` with the pulsing green dot CSS from the existing template. Use actual current day/date/time (ET).

### STEP 3d — TEAM LOGOS
Logo URL pattern: `https://www.mlbstatic.com/team-logos/{MLB_TEAM_ID}.svg`
```
ARI=109 ATL=144 BAL=110 BOS=111 CHC=112 CWS=145 CIN=113 CLE=114
COL=115 DET=116 HOU=117 KC=118 LAA=108 LAD=119 MIA=146 MIL=158
MIN=142 NYM=121 NYY=147 OAK=133 (ATH=133) PHI=143 PIT=134 SD=135
SF=137 SEA=136 STL=138 TB=139 TEX=140 TOR=141 WSH=120
```

`props.html`: inside each `<div class="player">`, prepend `<img class="team-logo" src="https://www.mlbstatic.com/team-logos/{ID}.svg" alt="{ABBREV}" loading="lazy" />` using the card's `data-team` abbrev.

`index.html`: each `<div class="matchup">Team A @ Team B</div>` renders as logo+name @ logo+name using `.team-logo.sm`.

## STEP 4 — DEPLOY

Do not regenerate `wrangler.jsonc`. Do not add/remove bindings. Run:
```bash
cd work
CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="9393ba26563604d847b6e1d03a2faa55" \
  npx --yes wrangler@4.83.0 deploy
```

Wrangler will read `main`, `d1_databases`, `assets` from the existing `wrangler.jsonc`. If the deploy output does NOT list `env.DB (mlb-tracking)` and `env.ASSETS`, abort and report — the config was tampered with.

The API token lives in `$CF_TOKEN` (scheduled task environment variable). If unset, abort — do not hardcode a token in this file.

## STEP 5 — POST-DEPLOY VERIFICATION
Immediately after deploy, query the active version via API and confirm it has at least `assets:ASSETS`, `d1:DB`, and `secret_text:SETTLE_SECRET`:
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/9393ba26563604d847b6e1d03a2faa55/workers/scripts/mlb-probabilities/deployments?order=desc&per_page=1" \
  -H "Authorization: Bearer $CF_TOKEN" | jq -r '.result.deployments[0].versions[0].version_id'
# then GET /versions/{id} and check resources.bindings
```
If fewer than 3 bindings are present, `wrangler rollback $PREV_VERSION` and report. Do not leave a broken deploy live.

## STEP 6 — HEALTH CHECKS (rollback on fail)
Fetch live site (expect 302 to Cloudflare Access login — that's fine, the Worker is up). Then fetch the asset-serve-directly mode via a known-good probe. Verify in the generated HTML files in `work/MLB_Probabilities/`:
- Today's date string appears in badge on both pages
- Pulsing green dot CSS present (`updated-badge`, `.dot`)
- ≥20 `data-reason=` occurrences across both pages
- ≥20 `data-pick-id=` occurrences across both pages
- ≥20 `data-conf-score=` occurrences across both pages (new DOE requirement)
- ≥20 `data-edge-pct=` occurrences across both pages
- ≥5 `stake-pill` occurrences
- `unit-guide` block on both pages
- ≥10 `class="team-logo` occurrences on each page
- ≥10 tooltips (`data-reason`) on `props.html`

If ANY check fails: `wrangler rollback $PREV_VERSION` and report.

## STEP 7 — REPORT
Brief 3–5 line summary: slate size, top-confidence picks, total units staked, deploy version ID, any rollback/issue. Include live URL `https://mlb-probabilities.bbaker-939.workers.dev/`.

## THINGS THIS SKILL MUST NEVER DO
- Regenerate `wrangler.jsonc` from scratch
- Regenerate `src/worker.js`
- Strip bindings from `wrangler.jsonc`
- Change `compatibility_date`
- Scaffold a minimal config if files are missing — **report instead**
- Hardcode a Cloudflare API token in this file
- Deploy if post-deploy binding verification fails
