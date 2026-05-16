// src/api/odds.js — Fetch FanDuel totals + moneyline odds
import { fetchJSON, loadEnv, loadTeams } from './client.js';

export async function fetchOdds() {
  loadEnv();
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️  No ODDS_API_KEY set, skipping odds');
    return [];
  }
  const teams = loadTeams();
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${apiKey}&regions=us&markets=totals,h2h&oddsFormat=american&bookmakers=fanduel`;
  try {
    const data = await fetchJSON(url, { label: 'odds' });
    const now = Date.now();

    // Map raw API data → our shape
    const entries = data.map(g => {
      const fd = g.bookmakers?.find(b => b.key === 'fanduel');
      const totals = fd?.markets.find(m => m.key === 'totals');
      const h2h    = fd?.markets.find(m => m.key === 'h2h');
      const over   = totals?.outcomes.find(o => o.name === 'Over');

      const awayName = g.away_team;
      const homeName = g.home_team;
      const awayAbbr = teams.nameToAbbr[awayName] || awayName;
      const homeAbbr = teams.nameToAbbr[homeName] || homeName;

      // h2h: find each team's odds
      let awayML = null, homeML = null;
      if (h2h?.outcomes) {
        for (const o of h2h.outcomes) {
          const abbr = teams.nameToAbbr[o.name] || o.name;
          const odds = o.price;
          const fmtOdds = odds >= 0 ? `+${odds}` : String(odds);
          if (abbr === awayAbbr) awayML = fmtOdds;
          else if (abbr === homeAbbr) homeML = fmtOdds;
        }
      }

      return {
        away: awayAbbr,
        home: homeAbbr,
        total: over?.point ?? null,
        awayML,
        homeML,
        commenceTime: g.commence_time,
      };
    }).filter(x => x.total != null || x.awayML != null);

    // Skip games that have already started
    const preGame = entries.filter(x => {
      const t = new Date(x.commenceTime).getTime();
      return t > now;
    });
    const droppedLive = entries.length - preGame.length;
    if (droppedLive > 0) {
      console.log(`  🕐 Skipped ${droppedLive} in-progress game(s) (live totals are remaining-runs, not full-game)`);
    }

    // Dedupe by (away, home) — keep the highest total per matchup.
    const grouped = {};
    for (const e of preGame) {
      const k = `${e.away}|${e.home}`;
      if (!grouped[k] || (e.total ?? 0) > (grouped[k].total ?? 0)) grouped[k] = e;
    }
    const deduped = Object.values(grouped);
    const dedupeSavings = preGame.length - deduped.length;
    if (dedupeSavings > 0) {
      console.log(`  🔀 Deduped ${dedupeSavings} duplicate-matchup entries (kept highest total per game)`);
    }

    for (const e of deduped) {
      if (e.total != null && e.total < 6.5) {
        console.log(`  ⚠️  Suspiciously low total for ${e.away}@${e.home}: ${e.total} — verify before betting.`);
      }
    }

    return deduped;
  } catch (err) {
    console.error(`  ❌ Odds API: ${err.message}`);
    return [];
  }
}
