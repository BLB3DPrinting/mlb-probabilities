import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SITE_DIR = join(ROOT, 'MLB_Probabilities');
const RESULTS_DIR = join(ROOT, 'sportsbotv2', 'data', 'results');
const date = process.env.SITE_DATE || defaultBuildDate();
const resultPath = join(RESULTS_DIR, `${date}.json`);

const TEAM_IDS = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113, CLE: 114,
  COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119, MIA: 146, MIL: 158,
  MIN: 142, NYM: 121, NYY: 147, ATH: 133, OAK: 133, PHI: 143, PIT: 134, SD: 135,
  SF: 137, SEA: 136, STL: 138, TB: 139, TEX: 140, TOR: 141, WSH: 120,
};

const TEAM_NAMES = {
  ARI: 'Diamondbacks', ATL: 'Braves', BAL: 'Orioles', BOS: 'Red Sox', CHC: 'Cubs',
  CWS: 'White Sox', CIN: 'Reds', CLE: 'Guardians', COL: 'Rockies', DET: 'Tigers',
  HOU: 'Astros', KC: 'Royals', LAA: 'Angels', LAD: 'Dodgers', MIA: 'Marlins',
  MIL: 'Brewers', MIN: 'Twins', NYM: 'Mets', NYY: 'Yankees', ATH: 'Athletics',
  OAK: 'Athletics', PHI: 'Phillies', PIT: 'Pirates', SD: 'Padres', SF: 'Giants',
  SEA: 'Mariners', STL: 'Cardinals', TB: 'Rays', TEX: 'Rangers', TOR: 'Blue Jays',
  WSH: 'Nationals',
};

if (!existsSync(join(ROOT, 'wrangler.jsonc'))) {
  throw new Error('wrangler.jsonc is missing; refusing to build a deployable Worker.');
}
if (!existsSync(join(ROOT, 'src', 'worker.js'))) {
  throw new Error('src/worker.js is missing; refusing to build without the API Worker.');
}
if (!process.env.ODDS_API_KEY && process.env.ALLOW_MISSING_MARKET_DATA !== '1') {
  throw new Error('ODDS_API_KEY is missing. Set it in Cloudflare build environment, or run with ALLOW_MISSING_MARKET_DATA=1 for a local dry run.');
}

console.log(`Building MLB probability assets for ${date}`);

const run = spawnSync(process.execPath, ['src/index.js', date], {
  cwd: join(ROOT, 'sportsbotv2'),
  stdio: 'inherit',
  env: process.env,
});
if (run.status !== 0) {
  throw new Error(`sportsbotv2 failed with exit code ${run.status}`);
}
if (!existsSync(resultPath)) {
  throw new Error(`sportsbotv2 did not write ${resultPath}`);
}

const results = JSON.parse(readFileSync(resultPath, 'utf8'));
if ((results.games || []).every((game) => game.line == null) && process.env.ALLOW_MISSING_MARKET_DATA !== '1') {
  throw new Error('No market totals were found. Refusing to publish a no-picks build; check ODDS_API_KEY or The Odds API availability.');
}
const schedule = await fetchSchedule(date).catch((err) => {
  console.warn(`Could not fetch MLB schedule metadata: ${err.message}`);
  return new Map();
});

renderIndex(results, schedule);
renderProps();

const verify = spawnSync(process.execPath, ['scripts/verify-fresh-assets.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, SITE_DATE: date },
});
if (verify.status !== 0) {
  throw new Error(`fresh asset verification failed with exit code ${verify.status}`);
}

function renderIndex(data, scheduleByMatchup) {
  const source = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
  const style = extractStyle(source);
  const scripts = extractScripts(source);
  const badge = formatBadge(data.date);
  const games = data.games || [];
  const picks = games.filter((g) => g.pick && g.pick !== 'NO PLAY');
  const high = picks.filter((g) => confidenceTier(g) === 'hi').length;
  const overs = picks.filter((g) => g.pick === 'OVER').length;
  const unders = picks.filter((g) => g.pick === 'UNDER').length;
  const cards = games.map((game, index) => gameCard(game, scheduleByMatchup, index)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MLB Daily Probabilities - ${badge.long}</title>
${style}
</head>

<body>

<header>
  <div class="header-row">
    <div>
      <h1>MLB Daily Probabilities Report</h1>
      <div class="sub">${badge.long} - ${games.length} games - <i>Hover or tap any pick for reasoning</i></div>
    </div>
    <nav class="nav">
      <a href="/" class="active">Games</a>
      <a href="/props">Player Props</a>
      <a href="/leaderboard">Leaderboard</a>
      <a id="me-link" class="me-link" href="/me" style="display:none;">Me</a>
    </nav>
  </div>
</header>
<div id="auth-banner" class="auth-banner">
  <strong>Track your picks -</strong> sign in to save any pick to your personal ROI log.
  <a href="/me">Sign in</a>
</div>
<div class="summary">
  <div class="stat"><div class="k">Games today</div><div class="v">${games.length}</div></div>
  <div class="stat"><div class="k">High-conf picks</div><div class="v" style="color:var(--good)">${high}</div></div>
  <div class="stat"><div class="k">Over leans</div><div class="v" style="color:var(--over)">${overs}</div></div>
  <div class="stat"><div class="k">Under leans</div><div class="v" style="color:var(--under)">${unders}</div></div>
</div>
<div class="toolbar">
  <span class="chip active" data-filter="all">All</span>
  <span class="chip" data-filter="hi">High confidence</span>
  <span class="chip" data-filter="over">Over leans</span>
  <span class="chip" data-filter="under">Under leans</span>
  <span class="chip" data-filter="weather">Weather alerts</span>
  <span class="chip" data-filter="injury">Key injuries</span>
  <span class="chip" data-filter="confirmed">Confirmed lineups</span>
  <input type="text" id="search" placeholder="Search teams / pitchers..." />
</div>

<div class="unit-guide" style="margin: 0 32px 8px; background:#0c1428; border:1px solid var(--border); border-radius:10px; padding:12px 14px; font-size:12px; color:var(--muted);"><b style="color:#fff;">Unit guide</b> - Straight bets sized by edge: <span style="font-family:'SF Mono',Menlo,Consolas,monospace;"><b>1.25-1.50u</b> high-conf</span> - <span style="font-family:'SF Mono',Menlo,Consolas,monospace;"><b>0.75-1.00u</b> medium</span> - <span style="font-family:'SF Mono',Menlo,Consolas,monospace;"><b>0.50u</b> low</span>.</div>

<div class="grid" id="grid">
${cards}
</div>

<footer>
  <div><b>Method:</b> Totals projected by SportsBotv2 using pitcher, offense, park, weather, and tactician adjustments. Confidence = edge magnitude plus model confidence. <b>Hover or tap any pick or tag to see reasoning.</b></div>
  <div class="legend">
    <span class="swatch"><span style="background:#4ade80"></span> High confidence</span>
    <span class="swatch"><span style="background:#fbbf24"></span> Medium confidence</span>
    <span class="swatch"><span style="background:#9fb0c9"></span> Low / pass</span>
    <span class="swatch"><span style="background:#fb923c"></span> Over lean</span>
    <span class="swatch"><span style="background:#60a5fa"></span> Under lean</span>
    <span class="swatch" style="margin-left:10px;"><span style="background:#4ade80"></span> Stake size by edge magnitude</span>
  </div>
  <div style="margin-top:10px; color:#8294b0;">Not betting advice. Verify lineups at first pitch - weather, scratches, and bullpen usage update constantly.</div>
  <div class="last-updated-badge" data-ts="${badge.iso}" title="Last automated refresh"><span class="lu-dot" aria-hidden="true"></span><span class="lu-label">Updated</span><span class="lu-value">${badge.short}</span></div>
</footer>

${scripts}

</body>
</html>
`;

  writeFileSync(join(SITE_DIR, 'index.html'), html);
}

function renderProps() {
  const source = readFileSync(join(SITE_DIR, 'props.html'), 'utf8');
  const style = extractStyle(source);
  const scripts = extractScripts(source);
  const badge = formatBadge(date);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MLB Player Props - ${badge.long}</title>
${style}
</head>
<body>

<header>
  <div class="row">
    <div>
      <h1>MLB Player Props</h1>
      <div class="sub">${badge.long} - No prop picks today (categories stripped)</div>
    </div>
    <nav class="nav">
      <a href="/">Games</a>
      <a href="/props" class="active">Player Props</a>
      <a href="/leaderboard">Leaderboard</a>
      <a id="me-link" class="me-link" href="/me" style="display:none;">Me</a>
    </nav>
  </div>
</header>
<div id="auth-banner" class="auth-banner">
  <strong>Track your picks -</strong> sign in to save any pick to your personal ROI log.
  <a href="/me">Sign in</a>
</div>

<div class="toolbar">
  <div class="group">
    <span class="chip active" data-filter="all">All (0)</span>
    <span class="chip" data-filter="hr">HR</span>
    <span class="chip" data-filter="hits">Hits</span>
    <span class="chip" data-filter="ks">K</span>
  </div>
  <div class="divider"></div>
  <select id="teamFilter">
    <option value="">All teams</option>
    <option>ARI</option><option>ATH</option><option>ATL</option><option>BAL</option><option>BOS</option><option>CHC</option><option>CIN</option><option>CLE</option><option>COL</option><option>CWS</option><option>DET</option><option>HOU</option><option>KC</option><option>LAA</option><option>LAD</option><option>MIA</option><option>MIL</option><option>MIN</option><option>NYM</option><option>NYY</option><option>PHI</option><option>PIT</option><option>SD</option><option>SEA</option><option>SF</option><option>STL</option><option>TB</option><option>TEX</option><option>TOR</option><option>WSH</option>
  </select>
  <input type="text" id="search" placeholder="Search player, team..." />
</div>

<div class="unit-guide" style="margin: 18px 32px 0;"><b>Status</b> - Prop categories temporarily disabled based on ROI tracking.</div>

<div class="empty-notice" style="padding:60px 20px; text-align:center; color:#aaa;">
  <h2 style="margin:0 0 12px;">No prop picks today</h2>
  <p style="margin:0; max-width:520px; margin-left:auto; margin-right:auto; line-height:1.5;">
    Prop categories are paused so the page can focus capital on totals generated by SportsBotv2.
  </p>
  <p style="margin:24px 0 0;"><a href="/" style="color:#60a5fa;">See today's totals on the main page</a></p>
</div>

<footer>
  <div><b>Status:</b> Prop categories are temporarily disabled. The build still refreshes this page so stale dates cannot be deployed.</div>
  <div style="margin-top:8px;">Not betting advice. Verify lineups at first pitch.</div>
  <div class="last-updated-badge" data-ts="${badge.iso}" title="Last automated refresh"><span class="lu-dot" aria-hidden="true"></span><span class="lu-label">Updated</span><span class="lu-value">${badge.short}</span></div>
  <div class="lu-refresh-note">Categories stripped - refreshed ${badge.time}</div>
</footer>

${scripts}

</body>
</html>
`;
  writeFileSync(join(SITE_DIR, 'props.html'), html);
}

function gameCard(game, scheduleByMatchup, index) {
  const meta = scheduleByMatchup.get(`${game.away}@${game.home}`) || {};
  const tier = confidenceTier(game);
  const ou = game.pick === 'OVER' ? 'over' : game.pick === 'UNDER' ? 'under' : 'neutral';
  const weather = hasWeatherAlert(game) ? 'alert' : 'calm';
  const pick = totalPill(game, index);
  const venue = meta.venue ? ` - ${escapeHtml(meta.venue)}` : '';
  const tag = weatherTag(game);
  const awayName = teamName(game.away);
  const homeName = teamName(game.home);

  return `<article class="card" data-conf="${tier}" data-ou="${ou}" data-weather="${weather}" data-injury="none"><div class="head"><div><div class="matchup"><span class="matchup-logos">${teamLogo(game.away)}${awayName}<span class="vs">@</span>${teamLogo(game.home)}${homeName}</span></div><div class="time">${escapeHtml(meta.time || 'Time TBD')}${venue}</div></div>${tag}</div><div class="pitchers"><b>${escapeHtml(game.away)}:</b> ${escapeHtml(meta.awayPitcher || 'TBD')} - <b>${escapeHtml(game.home)}:</b> ${escapeHtml(meta.homePitcher || 'TBD')}</div><div class="probs"><span class="away">Projected total</span><span class="home">${escapeHtml(String(round(game.combined || game.projected)))} runs${game.line ? ` vs ${escapeHtml(String(game.line))}` : ''}</span></div><div class="bar"><span style="width:${totalBarWidth(game)}%"></span></div><div class="pick-row"><div class="pill neutral"><div class="label">Winner</div><div class="value">No ML play <span class="conf-lo">PASS</span></div></div>${pick}</div><div class="factors"><div class="block" data-reason="${escapeAttr(weatherReason(game))}"><b>Weather:</b> ${escapeHtml(weatherSummary(game))}</div><div class="block" data-reason="${escapeAttr(modelReason(game))}"><b>Model:</b> ${escapeHtml(modelSummary(game))}</div></div></article>`;
}

function totalPill(game, index) {
  if (!game.pick || game.pick === 'NO PLAY' || !game.line) {
    return `<div class="pill neutral"><div class="label">Total</div><div class="value">No play <span class="conf-lo">PASS</span></div></div>`;
  }
  const direction = game.pick === 'OVER' ? 'over' : 'under';
  const label = game.pick === 'OVER' ? 'O' : 'U';
  const edge = Number(game.edge || 0);
  const conf = confidenceTier(game);
  const score = confidenceScore(game);
  const units = unitsForEdge(edge);
  const pickId = `${date}:total:${game.away}-${game.home}:${direction[0]}-${String(game.line).replace('.', '-')}`;
  const meta = {
    pick_id: pickId,
    type: 'total',
    team: null,
    line: game.line,
    odds: '-110',
    units,
    description: `${game.away} @ ${game.home} ${game.pick} ${game.line}`,
    date,
  };
  const factors = {
    model: 'sportsbotv2',
    projected: round(game.projected),
    combined: round(game.combined || game.projected),
    edge_runs: round(edge),
    confidence: game.confidence,
    tactician_total: round(game.tactician?.total || 0),
  };
  return `<div class="pill ${direction}" data-pick-id="${escapeAttr(pickId)}" data-conf-score="${score}" data-edge-pct="${Math.abs(edge / 10).toFixed(3)}" data-weather-cert="${hasWeatherData(game) ? '1.0' : '0.7'}" data-lineup-cert="1.0" data-factors="${escapeAttr(JSON.stringify(factors))}" ${index % 2 ? 'data-tip-side="left"' : ''} data-reason="${escapeAttr(totalReason(game))}"><div class="label">Total</div><div class="value">${label} ${escapeHtml(String(game.line))} <span class="conf-${conf}">${confLabel(conf)}</span></div><div class="pick-actions"><span class="stake-pill">${units}u</span><button class="btn-track" data-pick-id="${escapeAttr(pickId)}" data-pick-meta="${escapeAttr(JSON.stringify(meta))}" title="Sign in to track picks">Track</button></div></div>`;
}

async function fetchSchedule(isoDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher,venue,team`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MLB schedule HTTP ${response.status}`);
  const data = await response.json();
  const map = new Map();
  for (const dateEntry of data.dates || []) {
    for (const game of dateEntry.games || []) {
      const away = abbrFromId(game.teams.away.team.id, game.teams.away.team.abbreviation);
      const home = abbrFromId(game.teams.home.team.id, game.teams.home.team.abbreviation);
      map.set(`${away}@${home}`, {
        venue: game.venue?.name || '',
        time: formatGameTime(game.gameDate),
        awayPitcher: game.teams.away.probablePitcher?.fullName || 'TBD',
        homePitcher: game.teams.home.probablePitcher?.fullName || 'TBD',
      });
    }
  }
  return map;
}

function extractStyle(html) {
  return html.match(/<style>[\s\S]*?<\/style>/)?.[0] || '<style></style>';
}

function extractScripts(html) {
  return (html.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n\n');
}

function easternDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function defaultBuildDate() {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const etNoonUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
  const buildDate = new Date(etNoonUtc);
  if (Number(parts.hour) >= 20) {
    buildDate.setUTCDate(buildDate.getUTCDate() + 1);
  }
  return buildDate.toISOString().slice(0, 10);
}

function formatBadge(isoDate) {
  const dateOnly = new Date(`${isoDate}T12:00:00Z`);
  const long = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateOnly);
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  const shortDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dateOnly);
  return {
    long,
    short: `${shortDate} - ${time}`,
    time,
    iso: now.toISOString(),
  };
}

function formatGameTime(value) {
  if (!value) return 'Time TBD';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function abbrFromId(id, fallback) {
  return Object.entries(TEAM_IDS).find(([, teamId]) => teamId === Number(id))?.[0] || fallback;
}

function teamLogo(abbr) {
  const id = TEAM_IDS[abbr];
  return id ? `<img class="team-logo sm" src="https://www.mlbstatic.com/team-logos/${id}.svg" alt="${escapeAttr(abbr)}" loading="lazy" />` : '';
}

function teamName(abbr) {
  return escapeHtml(TEAM_NAMES[abbr] || abbr);
}

function confidenceTier(game) {
  const edge = Math.abs(Number(game.edge || 0));
  if (edge >= 1.25 || game.confidence === 'high') return 'hi';
  if (edge >= 0.75 || game.confidence === 'medium') return 'md';
  return 'lo';
}

function confidenceScore(game) {
  const tier = confidenceTier(game);
  const edgeBoost = Math.min(15, Math.round(Math.abs(Number(game.edge || 0)) * 5));
  if (tier === 'hi') return 75 + edgeBoost;
  if (tier === 'md') return 60 + edgeBoost;
  return 50 + edgeBoost;
}

function confLabel(tier) {
  return tier === 'hi' ? 'HIGH' : tier === 'md' ? 'MED' : 'LOW';
}

function unitsForEdge(edge) {
  const abs = Math.abs(Number(edge || 0));
  if (abs >= 1.5) return 1.5;
  if (abs >= 1.0) return 1.0;
  if (abs >= 0.5) return 0.75;
  return 0.5;
}

function weatherAdjustmentRuns(game) {
  return Number(game.breakdown?.weatherAdj ?? game.breakdown?.weather ?? 0);
}

function hasWeatherData(game) {
  return game.breakdown?.weatherAdj != null || game.breakdown?.weather != null || game.tactician?.breakdown?.weather != null;
}

function hasWeatherAlert(game) {
  return Math.abs(weatherAdjustmentRuns(game)) >= 0.5;
}

function weatherTag(game) {
  if (!hasWeatherData(game)) return '<span class="tag dome" data-reason="No outdoor weather adjustment available.">Weather n/a</span>';
  const adj = weatherAdjustmentRuns(game);
  if (adj >= 0.5) return `<span class="tag windout" data-reason="${escapeAttr(weatherReason(game))}">Run boost</span>`;
  if (adj <= -0.5) return `<span class="tag windin" data-reason="${escapeAttr(weatherReason(game))}">Run drag</span>`;
  return `<span class="tag" data-reason="${escapeAttr(weatherReason(game))}">Modest wx</span>`;
}

function weatherSummary(game) {
  if (!hasWeatherData(game)) return 'No live weather adjustment';
  return `Weather adj ${signed(round(weatherAdjustmentRuns(game)))}r`;
}

function weatherReason(game) {
  if (!hasWeatherData(game)) return 'No OpenWeather API data was available for this build, or the game is in a roofed venue.';
  return `SportsBotv2 weather component adjusted the run environment by ${signed(round(weatherAdjustmentRuns(game)))} runs.`;
}

function modelSummary(game) {
  if (!game.line) return `Model ${round(game.combined || game.projected)}; market line unavailable`;
  return `Model ${round(game.combined || game.projected)} vs line ${game.line}`;
}

function modelReason(game) {
  const tact = round(game.tactician?.total || 0);
  return `Base projection ${round(game.projected)} with tactician adjustment ${signed(tact)} runs.`;
}

function totalReason(game) {
  return `${game.pick} ${game.line}: projected ${round(game.combined || game.projected)} vs market ${game.line}, edge ${signed(round(game.edge || 0))} runs. ${modelReason(game)}`;
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function totalBarWidth(game) {
  if (!game.line) return 50;
  const edge = Number(game.edge || 0);
  return clamp(Math.round(50 + edge * 10), 20, 80);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}
