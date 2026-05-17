// src/index.js — Main entry point for SportsBotv2
// Run: node src/index.js [YYYY-MM-DD]

import { fetchSchedule } from './api/schedule.js';
import { fetchPitcherStats, fetchPitcherHand } from './api/pitcher.js';
import { fetchTeamStats } from './api/team.js';
import { fetchOdds } from './api/odds.js';
import { fetchAllWeather } from './api/weather.js';
import { fetchRoster, calcPlatoon } from './api/roster.js';
import { project } from './model/project.js';
import { getStadium } from './model/park.js';
import { tacticianScore, daysRestAdjustment, workloadDecay } from './model/tactician.js';
import { printResults, printSummary } from './output/console.js';
import { printTactician, printCombined } from './output/tactician.js';
import { saveResults } from './output/json.js';
import { loadConfig, loadTeams } from './api/client.js';

const date = process.argv[2] || new Date(Date.now() - 4*60*60*1000).toISOString().slice(0, 10);
const season = date.slice(0, 4);
const config = loadConfig();
const teams = loadTeams();

console.log(`\n🏟️  SportsBotv2 — MLB O/U Projections for ${date}\n`);

// ── 1. Fetch schedule ──
console.log('1️⃣  Fetching schedule...');
const games = await fetchSchedule(date);
console.log(`   Found ${games.length} games\n`);

if (games.length === 0) {
  console.log('No games scheduled today. Done.');
  process.exit(0);
}

// ── 2. Collect IDs ──
const pitcherIds = new Set();
const teamIds = new Set();
for (const g of games) {
  if (g.away.starter?.id) pitcherIds.add(g.away.starter.id);
  if (g.home.starter?.id) pitcherIds.add(g.home.starter.id);
  teamIds.add(g.away.id);
  teamIds.add(g.home.id);
}

// ── 3. Fetch pitcher stats (with rest days) ──
console.log('2️⃣  Fetching pitcher stats...');
const pitcherLogs = {};
const pitcherHands = {};
for (const pid of pitcherIds) {
  pitcherLogs[pid] = await fetchPitcherStats(pid, season, date);
  pitcherHands[pid] = await fetchPitcherHand(pid);
}
const pFound = Object.values(pitcherLogs).filter(Boolean).length;
console.log(`   Got stats for ${pFound}/${pitcherIds.size} pitchers\n`);

// ── 4. Fetch team stats ──
console.log('3️⃣  Fetching team stats...');
const teamLogs = {};
for (const tid of teamIds) {
  teamLogs[tid] = await fetchTeamStats(tid, season);
}
const tFound = Object.values(teamLogs).filter(Boolean).length;
console.log(`   Got stats for ${tFound}/${teamIds.size} teams\n`);

// ── 5. Fetch rosters for platoon splits ──
console.log('4️⃣  Fetching rosters (platoon splits)...');
const rosters = {};
for (const tid of teamIds) {
  rosters[tid] = await fetchRoster(tid);
}
console.log(`   Got rosters for ${Object.keys(rosters).length} teams\n`);

// ── 6. Fetch odds ──
console.log('5️⃣  Fetching odds...');
const odds = await fetchOdds();
console.log(`   Got lines for ${odds.length} games\n`);

// ── 7. Fetch weather ──
console.log('6️⃣  Fetching weather...');
const outdoorStadiums = {};
for (const abbr of [...new Set(games.map(g => g.home.abbr))]) {
  const s = getStadium(abbr);
  if (s && !s.roof) outdoorStadiums[abbr] = s;
}
const weather = await fetchAllWeather(outdoorStadiums);
const wCount = Object.values(weather).filter(Boolean).length;
console.log(`   Got weather for ${wCount} outdoor stadiums\n`);

// ── 8. Run projections + tactician ──
console.log('7️⃣  Running projections + tactician analysis...\n');

const results = [];

for (const g of games) {
  const awayPitcherLog = g.away.starter?.id ? pitcherLogs[g.away.starter.id] : null;
  const homePitcherLog = g.home.starter?.id ? pitcherLogs[g.home.starter.id] : null;
  const awayTeamLog = teamLogs[g.away.id];
  const homeTeamLog = teamLogs[g.home.id];
  const awayRoster = rosters[g.away.id];
  const homeRoster = rosters[g.home.id];

  const { projected, confidence, breakdown } = project({
    homeAbbr: g.home.abbr,
    awayPitcherLog,
    homePitcherLog,
    awayTeamLog,
    homeTeamLog,
    weather: weather[g.home.abbr],
  });

  const stadium = getStadium(g.home.abbr);
  const weatherData = weather[g.home.abbr];

  const awayPitcherHand = g.away.starter?.id ? pitcherHands[g.away.starter.id] : null;
  const homePitcherHand = g.home.starter?.id ? pitcherHands[g.home.starter.id] : null;

  const awayPlatoon = calcPlatoon(homeRoster, awayPitcherHand);
  const homePlatoon = calcPlatoon(awayRoster, homePitcherHand);

  const awayRestDays = awayPitcherLog?.restDays ?? null;
  const homeRestDays = homePitcherLog?.restDays ?? null;

  const awayWorkload = awayPitcherLog ? workloadDecay(awayPitcherLog.total.ip) : 0;
  const homeWorkload = homePitcherLog ? workloadDecay(homePitcherLog.total.ip) : 0;

  const tactInput = {
    pitcher: awayPitcherLog ? {
      avgPitchCount: 95,
      seasonIP: awayPitcherLog.total?.ip || 0,
    } : null,
    weather: weatherData ? {
      tempF: weatherData.tempF,
      humidity: weatherData.humidity || 50,
      windMph: weatherData.windMph,
      windDeg: weatherData.windDeg,
    } : null,
    altitudeFt: stadium?.altitude || 0,
    cfBearing: stadium?.cfBearing || 0,
    barrelRate: awayTeamLog?.total ? (awayTeamLog.total.hr / awayTeamLog.total.pa) * 2.5 : null,
  };

  const tactician = tacticianScore(tactInput);

  const awayRestAdj = awayRestDays !== null ? daysRestAdjustment(awayRestDays) : 0;
  const homeRestAdj = homeRestDays !== null ? daysRestAdjustment(homeRestDays) : 0;

  const restPlatoonAdj = (awayRestAdj - homeRestAdj) + (awayPlatoon.adjustment - homePlatoon.adjustment);
  const workloadAdj = awayWorkload - homeWorkload;

  tactician.total += restPlatoonAdj + workloadAdj;
  tactician.breakdown.restDays = restPlatoonAdj;
  tactician.breakdown.workload = workloadAdj;
  tactician.breakdown.platoon = awayPlatoon.adjustment - homePlatoon.adjustment;
  tactician.total = Math.round(tactician.total * 100) / 100;

  const combined = projected + (tactician.total || 0);

  const match = odds.find(o => o.away === g.away.abbr && o.home === g.home.abbr);
  const line = match?.total || null;
  const ml = (match?.awayML && match?.homeML)
    ? { awayOdds: match.awayML, homeOdds: match.homeML }
    : null;

  let edge = null;
  let pick = 'NO PLAY';
  if (line) {
    edge = combined - line;
    if (Math.abs(edge) >= (config.edgeThreshold || 0.5)) {
      pick = edge > 0 ? 'OVER' : 'UNDER';
    }
  }

  const gameWarnings = [];
  if (!g.away.starter) gameWarnings.push(`${g.away.abbr}: Away starter TBD`);
  if (!g.home.starter) gameWarnings.push(`${g.home.abbr}: Home starter TBD`);
  if (awayRestDays !== null && awayRestDays <= 2) gameWarnings.push(`${g.away.abbr}: Short rest (${awayRestDays} days)`);
  if (homeRestDays !== null && homeRestDays <= 2) gameWarnings.push(`${g.home.abbr}: Short rest (${homeRestDays} days)`);

  results.push({
    away: g.away,
    home: g.home,
    gameTime: g.gameTime || null,
    venue: g.venue || null,
    projected,
    combined,
    line,
    ml,
    edge,
    pick,
    confidence,
    warnings: gameWarnings,
    breakdown,
    tactician,
    platoon: { away: awayPlatoon, home: homePlatoon },
    restDays: { away: awayRestDays, home: homeRestDays },
  });
}

// ── 9. Output ──
printResults(results);
printSummary(results);

console.log('🧠 TACTICIAN ANALYSIS:');
console.log('───────────────────────────────────────────────');
for (const r of results) {
  const matchup = `${r.away.abbr} @ ${r.home.abbr}`;
  printTactician(matchup, r.tactician);
  printCombined(r);

  if (r.platoon.away.adjustment !== 0 || r.platoon.home.adjustment !== 0) {
    const a = r.platoon.away;
    const h = r.platoon.home;
    console.log(`  ⚔️  Platoon: away lineup ${a.favorable}L/${a.unfavorable}R/${a.neutral}S vs home pitcher → ${a.adjustment > 0 ? '+' : ''}${a.adjustment.toFixed(2)}`);
    console.log(`           home lineup ${h.favorable}L/${h.unfavorable}R/${h.neutral}S vs away pitcher → ${h.adjustment > 0 ? '+' : ''}${h.adjustment.toFixed(2)}`);
  }

  if (r.restDays.away !== null || r.restDays.home !== null) {
    console.log(`  📅 Rest: ${r.away.abbr} starter on ${r.restDays.away ?? '?'} days rest | ${r.home.abbr} starter on ${r.restDays.home ?? '?'} days rest`);
  }
}
console.log('');

saveResults(date, results);

console.log('✅ Done!\n');
