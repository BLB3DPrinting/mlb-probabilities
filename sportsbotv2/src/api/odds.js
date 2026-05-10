// src/api/odds.js — Fetch FanDuel totals lines
import { fetchJSON, loadEnv, loadTeams } from './client.js';

export async function fetchOdds() {
  loadEnv();
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️  No ODDS_API_KEY set, skipping odds');
    return [];
  }
  const teams = loadTeams();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${apiKey}&regions=us&markets=totals&oddsFormat=american&bookmakers=fanduel`;
  try {
    const data = await fetchJSON(url, { label: 'odds' });
    const now = Date.now();

    // Map raw API data → our shape
    const entries = data.map(g => {
      const fd = g.bookmakers?.find(b => b.key === 'fanduel');
      const totals = fd?.markets.find(m => m.key === 'totals');
      const over = totals?.outcomes.find(o => o.name === 'Over');
      return {
        away: teams.nameToAbbr[g.away_team] || g.away_team,
        home: teams.nameToAbbr[g.home_team] || g.home_team,
        total: over?.point,
        commenceTime: g.commence_time,
      };
    }).filter(x => x.total != null);

    // Skip games that have already started — live in-game totals are
    // "remaining runs" lines, not full-game lines. Pre-game runs only.
    const preGame = entries.filter(x => {
      const t = new Date(x.commenceTime).getTime();
      return t > now;
    });
    const droppedLive = entries.length - preGame.length;
    if (droppedLive > 0) {
      console.log(`  🕐 Skipped ${droppedLive} in-progress game(s) (live totals are remaining-runs, not full-game)`);
    }

    // Dedupe by (away, home) — keep the highest total per matchup.
    // Protects against doubleheaders, alt-market quirks, or accidental
    // F5/innings-1-5 lines appearing alongside full-game lines.
    // Full-game totals are always higher than F5 totals.
    const grouped = {};
    for (const e of preGame) {
      const k = `${e.away}|${e.home}`;
      if (!grouped[k] || e.total > grouped[k].total) grouped[k] = e;
    }
    const deduped = Object.values(grouped);
    const dedupeSavings = preGame.length - deduped.length;
    if (dedupeSavings > 0) {
      console.log(`  🔀 Deduped ${dedupeSavings} duplicate-matchup entries (kept highest total per game)`);
    }

    // Sanity warn — pre-game MLB full-game totals are essentially never
    // below 6.5. If we still have one after dedupe, something is odd.
    for (const e of deduped) {
      if (e.total < 6.5) {
        console.log(`  ⚠️  Suspiciously low total for ${e.away}@${e.home}: ${e.total} — typical pre-game full-game range is 6.5-13.5. May be an F5 or alt-line that survived dedupe. Verify before betting.`);
      }
    }

    return deduped;
  } catch (err) {
    console.error(`  ❌ Odds API: ${err.message}`);
    return [];
  }
}
