# Cloudflare Git Deploy

Cloudflare's GitHub integration deploys whatever is in `MLB_Probabilities/`.
If it runs with no build command, it can publish stale checked-in HTML.

Use this Worker build command in Cloudflare:

```bash
npm run build
```

The build command:

1. Runs `sportsbotv2` for the current Eastern date.
2. Writes fresh `MLB_Probabilities/index.html` and `MLB_Probabilities/props.html`.
3. Fails the build if either page still contains stale `2026-05-14` content.

Set these build environment variables in Cloudflare:

- `ODDS_API_KEY` - required; enables FanDuel total lines through The Odds API. The build fails without it so Cloudflare does not publish a no-picks page.
- `OPENWEATHER_API_KEY` - optional but recommended; enables outdoor weather adjustments.
- `SITE_DATE` - optional override for backfills, formatted `YYYY-MM-DD`.

For local dry runs without market data:

```bash
ALLOW_MISSING_MARKET_DATA=1 npm run build
```

Required Worker variables remain in `wrangler.jsonc`:

- `ADMIN_EMAIL`
- D1 binding `DB`
- Assets binding `ASSETS`

`SETTLE_SECRET` is still a Worker secret and should be set with Wrangler or the Cloudflare dashboard, not committed.
