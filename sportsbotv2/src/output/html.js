// src/output/html.js — Generate MLB_Probabilities/index.html from sportsbotv2 JSON
// Run: node src/output/html.js [YYYY-MM-DD]
// Reads:  sportsbotv2/data/results/YYYY-MM-DD.json
//         MLB_Probabilities/index.html (template — CSS/JS preserved)
// Writes: MLB_Probabilities/index.html
//         MLB_Probabilities/props.html (date-stamp updated only)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadTeams } from '../api/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..'); // sportsbotv2/
const SITE = join(ROOT, '..', 'MLB_Probabilities');
const DATA_DIR = join(ROOT, 'data', 'results');

// ─── Team logo IDs ────────────────────────────────────────────────────────────
const TEAM_IDS = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, ATH: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function logoUrl(abbr) {
  const id = TEAM_IDS[abbr];
  return id ? `https://www.mlbstatic.com/team-logos/${id}.svg` : '';
}

function escAttr(obj) {
  return JSON.stringify(obj).replace(/"/g, '&quot;');
}

function oddsToProb(oddsStr) {
  const n = parseInt(String(oddsStr).replace('+', ''));
  if (n > 0) return 100 / (100 + n);
  return Math.abs(n) / (100 + Math.abs(n));
}

function devig(awayOddsStr, homeOddsStr) {
  const p1 = oddsToProb(awayOddsStr);
  const p2 = oddsToProb(homeOddsStr);
  const sum = p1 + p2;
  return { fairAway: p1 / sum, fairHome: p2 / sum };
}

function probToAmerican(p) {
  if (p >= 0.5) return -Math.round(p / (1 - p) * 100);
  return Math.round((1 - p) / p * 100);
}

function fmtOdds(n) {
  return n >= 0 ? `+${n}` : String(n);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS_LONG[m - 1]} ${d}, ${y}`;
}

function shortDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${DAYS[dt.getUTCDay()].slice(0, 3)}, ${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

function formatGameTime(isoTime) {
  if (!isoTime) return 'TBD';
  const d = new Date(isoTime);
  const month = d.getUTCMonth();
  // DST: 2nd Sun Mar – 1st Sun Nov (approximate)
  const offset = (month >= 2 && month <= 9) ? -4 : -5;
  const h = (d.getUTCHours() + offset + 24) % 24;
  const min = d.getUTCMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${min} ${period} ET`;
}

// ─── Confidence helpers ───────────────────────────────────────────────────────
function confData(conf) {
  if (conf === 'high')   return { key: 'hi', html: '<span class="conf-hi">HIGH</span>', score: 82, units: { ml: 1.0, total: 1.5 } };
  if (conf === 'medium') return { key: 'md', html: '<span class="conf-md">MED</span>',  score: 63, units: { ml: 0.75, total: 1.0 } };
  return                        { key: 'lo', html: '<span class="conf-lo">LOW</span>',  score: 50, units: { ml: 0.5, total: 0.75 } };
}

// ─── Weather tag ──────────────────────────────────────────────────────────────
function weatherTag(g) {
  const teams = loadTeams();
  const stadium = teams.stadiums[g.home];
  if (stadium?.roof) {
    return { cls: 'dome', label: 'Roof', attr: 'calm', reason: 'Roof / closed stadium reduces weather impact.', isDome: true };
  }
  const wxAdj = g.breakdown?.weatherAdj || 0;
  if (wxAdj > 0.5)  return { cls: 'windout', label: 'Wind out', attr: 'alert', reason: `Weather adds +${wxAdj.toFixed(2)}r — wind out / warm.`, isDome: false };
  if (wxAdj < -0.5) return { cls: 'windin',  label: 'Wind in',  attr: 'alert', reason: `Weather subtracts ${wxAdj.toFixed(2)}r — wind in / cold/dry.`, isDome: false };
  return { cls: '', label: 'Modest wx', attr: 'calm', reason: `Weather adj ${wxAdj > 0 ? '+' : ''}${wxAdj.toFixed(2)}r.`, isDome: false };
}

// ─── Win probability from model factors ──────────────────────────────────────
function modelWinProbs(g) {
  const bd = g.breakdown || {};
  const awayOff  = bd.awayOffense?.multiplier  ?? 1;
  const homeOff  = bd.homeOffense?.multiplier  ?? 1;
  const awaySpPk = bd.awayStarter?.parkAdjusted ?? 4.5;
  const homeSpPk = bd.homeStarter?.parkAdjusted ?? 4.5;
  const awayRPG = awayOff * homeSpPk;
  const homeRPG = homeOff * awaySpPk;
  const total   = awayRPG + homeRPG;
  const pAway   = total > 0 ? awayRPG / total : 0.5;
  return { pAway: Math.round(pAway * 100), pHome: Math.round((1 - pAway) * 100) };
}

// ─── Build total pick pill ────────────────────────────────────────────────────
function totalPill(g, date) {
  if (g.pick === 'NO PLAY' || !g.line) {
    return '<div class="pill neutral"><div class="label">Total</div><div class="value">No play <span class="conf-lo">PASS</span></div></div>';
  }
  const isOver  = g.pick === 'OVER';
  const ouLabel = isOver ? 'O' : 'U';
  const ouCls   = isOver ? 'over' : 'under';
  const bd      = g.breakdown || {};
  const tact    = g.tactician  || {};
  const cd      = confData(g.confidence);
  const edge    = Math.round((g.edge || 0) * 100) / 100;
  const edgePct = Math.abs(edge) / (g.line > 0 ? g.line : 1);
  const pickId  = `${date}:total:${g.away}-${g.home}:${ouLabel.toLowerCase()}-${String(g.line).replace('.', '-')}`;
  const desc    = `${g.away} @ ${g.home} ${g.pick} ${g.line}`;
  const units   = cd.units.total;
  const factors = escAttr({
    model: 'sportsbotv2',
    projected: g.projected,
    combined: g.combined,
    edge_runs: edge,
    park_factor: bd.parkFactor ?? 1,
    altitude_adj: bd.altitudeAdj ?? 0,
    weather_adj: Math.round((bd.weatherAdj ?? 0) * 100) / 100,
    away_sp_blended: bd.awayStarter?.blended ?? 4.5,
    away_sp_park_adj: bd.awayStarter?.parkAdjusted ?? 4.5,
    home_sp_blended: bd.homeStarter?.blended ?? 4.5,
    home_sp_park_adj: bd.homeStarter?.parkAdjusted ?? 4.5,
    away_off_mult: bd.awayOffense?.multiplier ?? 1,
    home_off_mult: bd.homeOffense?.multiplier ?? 1,
    tactician_total: tact.total ?? 0,
  });
  const reason = `Proj ${g.combined} vs line ${g.line} (edge ${edge >= 0 ? '+' : ''}${edge}r). Park ${bd.parkFactor?.toFixed(2) ?? '1.00'}; ${g.away} SP ${(bd.awayStarter?.blended ?? 4.5).toFixed(2)} ERA-eq. ${g.home} SP ${(bd.homeStarter?.blended ?? 4.5).toFixed(2)} ERA-eq. Tactician ${(tact.total ?? 0) >= 0 ? '+' : ''}${(tact.total ?? 0).toFixed(2)}r.`;
  const meta = escAttr({ pick_id: pickId, type: 'total', team: null, line: g.line, odds: '-110', units, description: desc, date });
  return `<div class="pill ${ouCls}" data-pick-id="${pickId}" data-conf-score="${cd.score}" data-edge-pct="${edgePct.toFixed(3)}" data-weather-cert="1.0" data-lineup-cert="1.0" data-factors="${factors}" data-tip-side="left" data-reason="${reason}"><div class="label">Total</div><div class="value">${ouLabel} ${g.line} ${cd.html}</div><div class="pick-actions"><span class="stake-pill">${units}u</span><button class="btn-track" data-pick-id="${pickId}" data-pick-meta="${meta}" title="Sign in to track picks">Track</button></div></div>`;
}

// ─── Build ML pick pill ───────────────────────────────────────────────────────
function mlPill(g, date) {
  if (!g.ml?.awayOdds || !g.ml?.homeOdds) {
    return '<div class="pill neutral"><div class="label">Winner</div><div class="value">No edge <span class="conf-lo">PASS</span></div></div>';
  }
  const { fairAway, fairHome } = devig(g.ml.awayOdds, g.ml.homeOdds);
  const bd = g.breakdown || {};
  const awayOff  = bd.awayOffense?.multiplier  ?? 1;
  const homeOff  = bd.homeOffense?.multiplier  ?? 1;
  const awaySpPk = bd.awayStarter?.parkAdjusted ?? 4.5;
  const homeSpPk = bd.homeStarter?.parkAdjusted ?? 4.5;
  const awayRPG  = awayOff * homeSpPk;
  const homeRPG  = homeOff * awaySpPk;
  const totalRPG = awayRPG + homeRPG;
  const modAway  = totalRPG > 0 ? awayRPG / totalRPG : 0.5;
  const modHome  = 1 - modAway;

  const edgeAway = modAway - fairAway;
  const edgeHome = modHome - fairHome;
  const EDGE_THRESHOLD = 0.03;

  let pickTeam = null, pickEdge = 0, pickOdds = '', pickFairOdds = 0, pickModProb = 0, pickFairProb = 0;
  if (edgeAway >= EDGE_THRESHOLD) {
    pickTeam = g.away; pickEdge = edgeAway; pickOdds = g.ml.awayOdds;
    pickFairOdds = probToAmerican(modAway); pickModProb = modAway; pickFairProb = fairAway;
  } else if (edgeHome >= EDGE_THRESHOLD) {
    pickTeam = g.home; pickEdge = edgeHome; pickOdds = g.ml.homeOdds;
    pickFairOdds = probToAmerican(modHome); pickModProb = modHome; pickFairProb = fairHome;
  }

  if (!pickTeam) {
    return '<div class="pill neutral"><div class="label">Winner</div><div class="value">No edge <span class="conf-lo">PASS</span></div></div>';
  }

  const teamName = pickTeam === g.away ? (g.awayName || g.away) : (g.homeName || g.home);
  const edgePp   = Math.round(pickEdge * 1000) / 10;
  const conf     = edgePp >= 8 ? 'high' : edgePp >= 5 ? 'medium' : 'low';
  const cd       = confData(conf);
  const units    = cd.units.ml;
  const pickId   = `${date}:ml:${g.away}-${g.home}:${pickTeam}`;
  const factors  = escAttr({
    model: 'ml_research_v2',
    fair_prob: Math.round(pickModProb * 1000) / 1000,
    implied_prob_devig: Math.round(pickFairProb * 1000) / 1000,
    edge_pp: edgePp,
    market_odds: pickOdds,
    fair_odds: fmtOdds(pickFairOdds),
    sp_blended: { away: bd.awayStarter?.blended ?? 4.5, home: bd.homeStarter?.blended ?? 4.5 },
    offense_mult: { away: awayOff, home: homeOff },
  });
  const reason = `${teamName} fair ${fmtOdds(pickFairOdds)} vs market ${pickOdds} (edge +${edgePp}pp). SP ERA-eq park-adj ${(bd.awayStarter?.parkAdjusted ?? 4.5).toFixed(2)} vs ${(bd.homeStarter?.parkAdjusted ?? 4.5).toFixed(2)}; offense mult ${awayOff.toFixed(3)}/${homeOff.toFixed(3)}.`;
  const meta = escAttr({ pick_id: pickId, type: 'ml', team: pickTeam, odds: pickOdds, units, description: `${teamName} ML`, date });
  return `<div class="pill win" data-pick-id="${pickId}" data-conf-score="${cd.score}" data-edge-pct="${pickEdge.toFixed(3)}" data-weather-cert="1.0" data-lineup-cert="1.0" data-factors="${factors}" data-reason="${reason}"><div class="label">Winner</div><div class="value">${teamName} ${cd.html}</div><div class="pick-actions"><span class="stake-pill">${units}u</span><button class="btn-track" data-pick-id="${pickId}" data-pick-meta="${meta}" title="Sign in to track picks">Track</button></div></div>`;
}

// ─── Build a single game card ─────────────────────────────────────────────────
function gameCard(g, date) {
  const wx = weatherTag(g);
  const cd = confData(g.confidence);
  const { pAway, pHome } = modelWinProbs(g);
  const awayName   = g.awayName  || g.away;
  const homeName   = g.homeName  || g.home;
  const time       = formatGameTime(g.gameTime);
  const venue      = g.venue || '';
  const timeVenue  = time + (venue ? ` · ${venue}` : '');
  const awayStarter = g.awayStarter || 'TBD';
  const homeStarter = g.homeStarter || 'TBD';
  const ouAttr = g.pick === 'OVER' ? 'over' : g.pick === 'UNDER' ? 'under' : 'neutral';
  const wxAttr = wx.isDome ? '' : `data-weather="${wx.attr}"`;
  const wxTagHtml = wx.isDome
    ? `<span class="tag dome" data-reason="${wx.reason}">Roof</span>`
    : wx.cls
      ? `<span class="tag ${wx.cls}" data-reason="${wx.reason}">${wx.label}</span>`
      : `<span class="tag" data-reason="${wx.reason}">${wx.label}</span>`;
  const bd = g.breakdown || {};
  const wxReason     = wx.isDome ? 'Roofed venue — weather minimal.' : wx.reason;
  const hasLowConf   = !g.awayStarter || !g.homeStarter;
  const healthReason = hasLowConf
    ? 'Confidence flag on a starter (TBD).'
    : 'Probables posted.';

  return `<article class="card" data-conf="${cd.key}" data-ou="${ouAttr}" ${wxAttr} data-injury="none"><div class="head"><div><div class="matchup"><span class="matchup-logos"><img class="team-logo sm" src="${logoUrl(g.away)}" alt="${g.away}" loading="lazy" />${awayName}<span class="vs">@</span><img class="team-logo sm" src="${logoUrl(g.home)}" alt="${g.home}" loading="lazy" />${homeName}</span></div><div class="time">${timeVenue}</div></div>${wxTagHtml}</div><div class="pitchers"><b>${g.away}:</b> ${awayStarter} · <b>${g.home}:</b> ${homeStarter}</div><div class="probs"><span class="away">${awayName} ${pAway}%</span><span class="home">${homeName} ${pHome}%</span></div><div class="bar"><span style="width:${pHome}%"></span></div><div class="pick-row">${mlPill(g, date)}${totalPill(g, date)}</div><div class="factors"><div class="block" data-reason="${wxReason}"><b>Weather:</b> ${wxReason}</div><div class="block" data-reason="${healthReason}"><b>Health:</b> ${healthReason}</div></div></article>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const today = process.argv[2] || new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const jsonPath = join(DATA_DIR, `${today}.json`);

  if (!existsSync(jsonPath)) {
    console.error(`❌ No data file found at ${jsonPath}. Run index.js first.`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const games = data.games || [];
  const date  = data.date || today;

  console.log(`🌐 Generating HTML for ${date} (${games.length} games)…`);

  // Count summary stats
  const highConf = games.filter(g => g.confidence === 'high' && g.pick !== 'NO PLAY').length;
  const overs    = games.filter(g => g.pick === 'OVER').length;
  const unders   = games.filter(g => g.pick === 'UNDER').length;

  // Build new sections
  const newSummary = `<div class="summary">
  <div class="stat"><div class="k">Games today</div><div class="v">${games.length}</div></div>
  <div class="stat"><div class="k">High-conf picks</div><div class="v" style="color:var(--good)">${highConf}</div></div>
  <div class="stat"><div class="k">Over leans</div><div class="v" style="color:var(--over)">${overs}</div></div>
  <div class="stat"><div class="k">Under leans</div><div class="v" style="color:var(--under)">${unders}</div></div>
</div>`;

  const cardHtml = games.map(g => gameCard(g, date)).join('\n');

  const ld = longDate(date);
  const sd = shortDate(date);
  const nowStr = `${sd} · ${new Date().getHours() % 12 || 12}:00 ${new Date().getHours() >= 12 ? 'PM' : 'AM'} ET`;
  const isoTs  = new Date().toISOString();

  // ── Patch index.html ─────────────────────────────────────────────────────
  const idxPath = join(SITE, 'index.html');
  let html = readFileSync(idxPath, 'utf8');

  // Title
  html = html.replace(/<title>MLB Daily Probabilities[^<]*<\/title>/,
    `<title>MLB Daily Probabilities — ${ld}</title>`);

  // Header sub (date · N games)
  html = html.replace(/<div class="sub">[\s\S]*?<\/div>(\s*\n\s*<\/div>\s*\n\s*<nav)/,
    `<div class="sub">${ld} · ${games.length} games · <i>Hover or tap any pick for reasoning</i></div>$1`);

  // Summary stats block (ends just before <div class="toolbar">)
  html = html.replace(/<div class="summary">[\s\S]*?<\/div>\n(<div class="toolbar")/,
    `${newSummary}\n$1`);

  // Game grid
  html = html.replace(/<div class="grid" id="grid">[\s\S]*?<\/div>\n\n(<footer)/,
    `<div class="grid" id="grid">\n${cardHtml}\n</div>\n\n$1`);

  // Footer timestamp (two badges)
  html = html.replace(/<span class="updated-badge"[\s\S]*?<\/span>[^<]*<\/span>/,
    `<span class="updated-badge" data-ts="${isoTs}" title="Last automated refresh"><span class="dot"></span> ${nowStr}</span>`);
  html = html.replace(/<div class="last-updated-badge"[\s\S]*?<\/div>/,
    `<div class="last-updated-badge" data-ts="${isoTs}" title="Last automated refresh"><span class="lu-dot" aria-hidden="true"></span><span class="lu-label">Updated</span><span class="lu-value">${nowStr}</span></div>`);

  writeFileSync(idxPath, html, 'utf8');
  console.log(`✅ Wrote ${idxPath}`);

  // ── Patch props.html (date stamp only) ────────────────────────────────────
  const propsPath = join(SITE, 'props.html');
  if (existsSync(propsPath)) {
    let props = readFileSync(propsPath, 'utf8');
    props = props.replace(/<title>MLB Player Props[^<]*<\/title>/,
      `<title>MLB Player Props — ${ld}</title>`);
    // Update props last-updated badge if it exists
    props = props.replace(/<div class="last-updated-badge"[\s\S]*?<\/div>/,
      `<div class="last-updated-badge" data-ts="${isoTs}" title="Last automated refresh"><span class="lu-dot" aria-hidden="true"></span><span class="lu-label">Updated</span><span class="lu-value">${nowStr}</span></div>`);
    writeFileSync(propsPath, props, 'utf8');
    console.log(`✅ Patched ${propsPath} (date stamp only)`);
  }
}

main();
