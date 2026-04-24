---
name: mlb-lineup-refresh
description: 4 PM ET refresh — re-checks tonight's MLB lineups, bumps or downgrades lineup_cert on picks in the existing HTML, regenerates only the affected pills, deploys. Runs daily at 4:00 PM ET.
---

You are doing a **lineup-lock refresh** on the existing MLB picks page. The 10 AM skill already ran today and produced index.html and props.html with picks based on probable lineups. Your job is ONLY to verify those assumptions against actual posted lineups and update the `data-lineup-cert` attribute + add/remove the lineup-TBD visual flag accordingly.

You must NOT:
- Re-research the slate (pitchers, odds, weather)
- Regenerate full game cards or prop cards
- Rebuild index.html or props.html from scratch
- Touch wrangler.jsonc, src/worker.js, or any migration file

You MUST:
- Read the existing index.html and props.html
- For each pick, check whether the featured player(s) and pitcher are in today's confirmed lineup
- Update only the `data-lineup-cert` attribute on each pill (and factor-card weather_cert stays as-is)
- If a pick's key player is scratched, mark the pick with `data-scratched="true"` and add a visible "SCRATCHED" badge (CSS already in place)
- Deploy

## STEP 0 — VERIFY INPUTS
Required inputs from uploads/ or mounted folder:
- `wrangler.jsonc`
- `src/worker.js`
- `MLB_Probabilities/index.html` (must exist and be from TODAY — check the date badge)
- `MLB_Probabilities/props.html` (same)

If index.html's date badge doesn't match today's date: abort with report. The 10 AM morning run didn't happen or failed; do not proceed — you'd end up updating yesterday's picks.

If any file missing: abort with report.

## STEP 1 — PULL TONIGHT'S LINEUPS
Sources, in order of preference:
1. MLB.com Gameday starting lineup (most authoritative, usually posted 2-3 hrs before first pitch)
2. RotoWire daily lineups (backup, includes projected lineups for afternoon games)
3. Team beat writers on X/Twitter for late scratches (<30 min before first pitch)

For each of the ~10-11 games on index.html, record:
- Confirmed starting pitcher (should match the `data-pitcher` or card's pitcher line)
- Top-9 batting order for both teams
- Any injury designation today (day-to-day, scratched, etc.)

## STEP 2 — SCORE EACH PICK'S LINEUP CERTAINTY
For every pill (pick) in index.html and every prop-card in props.html:

1. Find the featured player (from `data-pick-meta` or pill description) or, for ML/total/F5 picks, identify the key assumed players from the factors blob or pick reason.
2. Score `lineup_cert`:
   - `1.0` — all key players confirmed in lineup, at expected spots
   - `0.9` — player in lineup but at unexpected spot (e.g., dropped in order) — minor downgrade
   - `0.7` — one key player day-to-day questionable; pick still valid but variance up
   - `0.4` — material scratch (star hitter out, pitcher scratched)
   - `0.0` — scratched pick, full downgrade

3. Update the HTML: replace the pill's `data-lineup-cert="X.X"` attribute with the new value. Use a careful sed/regex that only matches within that specific pill (use `data-pick-id` as an anchor).

4. If `lineup_cert < 0.4`, add `data-scratched="true"` to the pill AND comment out the pick from display — i.e., change `class="pill win"` to `class="pill scratched"` (the CSS rule for `.scratched` hides it visually; existing class exists in live CSS or needs to be added).

## STEP 3 — UPDATE THE LAST-UPDATED BADGE
Find the `<div class="last-updated-badge">` in both HTML files' footer. Update:
- `data-ts` to the current ISO-8601 with ET offset
- The visible text to `{Day}, {Mon DD, YYYY} · {HH:MM} PM ET` — the current time in ET

Add a second row inside the badge indicating "Lineup refresh run" so it's clear this isn't the morning regeneration:
```html
<div class="lu-refresh-note">Lineup lock verified at {HH:MM} PM ET</div>
```

## STEP 4 — DEPLOY
Capture PREV_VERSION for rollback.
```bash
cd <working-dir>
PREV_VERSION=$(CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="9393ba26563604d847b6e1d03a2faa55" \
  npx --yes wrangler@4.83.0 deployments list 2>&1 | grep -oP 'Version\(s\):\s+\(100%\)\s+\K[a-f0-9-]+' | tail -1)
CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="9393ba26563604d847b6e1d03a2faa55" \
  npx --yes wrangler@4.83.0 deploy
```

Confirm the deploy output lists `env.DB` and `env.ASSETS`. If not, abort and do not proceed with verification.

## STEP 5 — POST-DEPLOY VERIFICATION (rollback on fail)
Query the live version's bindings via the Cloudflare API. If fewer than 3 bindings (ASSETS, DB, SETTLE_SECRET) are present, rollback to PREV_VERSION.

Then verify the HTML locally:
- `data-lineup-cert` values changed from morning run (should show some 1.0 values unchanged, some flipped up/down)
- Last-updated badge shows today's date + a PM time
- `.lu-refresh-note` element present

If any check fails: `wrangler rollback $PREV_VERSION` and report.

## STEP 6 — REPORT
Brief 3-5 line summary:
- Total picks reviewed: X
- Lineup confirmations (cert bumped to 1.0): Y
- Picks downgraded (cert reduced): Z, with player names
- Picks scratched: A, with player names and reasons
- Deploy version ID, any rollback/issue

Include live URL.

## THINGS THIS SKILL MUST NEVER DO
- Re-research probable pitchers, odds, or weather
- Regenerate game cards or prop cards from scratch
- Add new picks that weren't in the morning run
- Touch wrangler.jsonc, src/worker.js, or migrations
- Deploy without verifying bindings post-deploy
- Leave scratched picks visible to the user
