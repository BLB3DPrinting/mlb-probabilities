/**
 * MLB Probabilities — Worker with Tracking API
 *
 * Routes /api/* handled here; everything else falls through to static assets.
 * Auth: Cloudflare Access injects Cf-Access-Authenticated-User-Email on every
 * request. No header = reject 401.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getUserEmail(request) {
  return (
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('Cf-Access-Authenticated-User-Email') ||
    null
  );
}

async function ensureUser(db, email) {
  await db
    .prepare(
      `INSERT INTO users (email, first_seen, last_seen)
       VALUES (?1, unixepoch(), unixepoch())
       ON CONFLICT(email) DO UPDATE SET last_seen = unixepoch()`
    )
    .bind(email)
    .run();
}

/**
 * POST /api/track
 * Body: {
 *   pick_id, type, team, player?, line?, odds, units, description,
 *   // DOE fields — all optional, sent when the generator emits them:
 *   confidence_score?, edge_pct?, weather_cert?, lineup_cert?, factors?
 * }
 */
async function handleTrack(request, env) {
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const {
    pick_id, type, team, player, line, odds, units, description, date,
    confidence_score, edge_pct, weather_cert, lineup_cert, factors,
  } = body || {};
  if (!pick_id || !type || !odds || !units) {
    return json({ error: 'missing_fields' }, 400);
  }

  // factors may arrive as an object (preferred) or a JSON string.
  let factors_json = null;
  if (factors != null) {
    factors_json =
      typeof factors === 'string' ? factors : JSON.stringify(factors);
  }

  // Numeric parse with null fallback — we want "null" in the DB for unknowns,
  // not "0", so downstream calibration math doesn't treat absence as a real value.
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  await ensureUser(env.DB, email);

  // Upsert pick metadata. COALESCE so we don't overwrite real values with nulls
  // when a second user tracks the same pick without re-sending the DOE fields.
  await env.DB.prepare(
    `INSERT INTO picks (
        pick_id, pick_date, type, team, player, line, odds, units, description,
        confidence_score, edge_pct, weather_cert, lineup_cert, factors_json
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(pick_id) DO UPDATE SET
       type=excluded.type, team=excluded.team, player=excluded.player,
       line=excluded.line, odds=excluded.odds, units=excluded.units,
       description=excluded.description,
       confidence_score=COALESCE(excluded.confidence_score, picks.confidence_score),
       edge_pct=COALESCE(excluded.edge_pct, picks.edge_pct),
       weather_cert=COALESCE(excluded.weather_cert, picks.weather_cert),
       lineup_cert=COALESCE(excluded.lineup_cert, picks.lineup_cert),
       factors_json=COALESCE(excluded.factors_json, picks.factors_json)`
  )
    .bind(
      pick_id,
      date || new Date().toISOString().slice(0, 10),
      type,
      team || null,
      player || null,
      line || null,
      String(odds),
      Number(units),
      description || null,
      numOrNull(confidence_score),
      numOrNull(edge_pct),
      numOrNull(weather_cert),
      numOrNull(lineup_cert),
      factors_json
    )
    .run();

  // Insert tracking record (ignore dupes per user per pick)
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO tracked_picks (email, pick_id, tracked_at)
     VALUES (?1, ?2, unixepoch())`
  )
    .bind(email, pick_id)
    .run();

  return json({ ok: true, new_tracking: res.meta.changes > 0 });
}

/**
 * POST /api/untrack
 * Body: { pick_id }
 */
async function handleUntrack(request, env) {
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const { pick_id } = body || {};
  if (!pick_id) return json({ error: 'missing_pick_id' }, 400);

  const res = await env.DB.prepare(
    `DELETE FROM tracked_picks WHERE email = ?1 AND pick_id = ?2`
  )
    .bind(email, pick_id)
    .run();

  return json({ ok: true, removed: res.meta.changes });
}

/**
 * GET /api/pick-counts?date=YYYY-MM-DD
 * Returns { pick_id: count, ... } for social proof badges.
 */
async function handlePickCounts(request, env) {
  const url = new URL(request.url);
  const date =
    url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT tp.pick_id, COUNT(*) AS c
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     WHERE p.pick_date = ?1
     GROUP BY tp.pick_id`
  )
    .bind(date)
    .all();

  const counts = {};
  for (const r of results) counts[r.pick_id] = r.c;
  return json({ date, counts });
}

/**
 * GET /api/me/tracked?date=YYYY-MM-DD
 * Which of today's picks has this user already tracked?
 */
async function handleMeTracked(request, env) {
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const date =
    url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT tp.pick_id
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     WHERE tp.email = ?1 AND p.pick_date = ?2`
  )
    .bind(email, date)
    .all();

  return json({ email, date, pick_ids: results.map((r) => r.pick_id) });
}

/**
 * GET /api/me/stats
 * Running totals for the signed-in user.
 */
async function handleMeStats(request, env) {
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);

  await ensureUser(env.DB, email);

  const summary = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN s.outcome='W' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN s.outcome='L' THEN 1 ELSE 0 END) AS losses,
       SUM(CASE WHEN s.outcome='P' THEN 1 ELSE 0 END) AS pushes,
       SUM(CASE WHEN s.outcome='V' THEN 1 ELSE 0 END) AS voids,
       COALESCE(SUM(s.units_delta), 0) AS units_delta,
       COALESCE(SUM(p.units), 0) AS units_risked
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     LEFT JOIN settlements s ON s.pick_id = tp.pick_id
     WHERE tp.email = ?1`
  )
    .bind(email)
    .first();

  const { results: history } = await env.DB.prepare(
    `SELECT p.pick_id, p.pick_date, p.type, p.team, p.player, p.odds, p.units,
            p.description, p.confidence_score, p.edge_pct, p.weather_cert,
            p.lineup_cert, p.factors_json, p.closing_odds, p.closed_at,
            s.outcome, s.units_delta, tp.tracked_at
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     LEFT JOIN settlements s ON s.pick_id = tp.pick_id
     WHERE tp.email = ?1
     ORDER BY tp.tracked_at DESC
     LIMIT 100`
  )
    .bind(email)
    .all();

  return json({ email, summary, history });
}

/**
 * GET /api/me/calibration
 * Bucketed hit rate by confidence score, split by bet type.
 * Returns empty buckets until settlements accumulate — expect meaningful data
 * after ~30-50 settled picks per bucket.
 *
 * Buckets: 0-49 (skip), 50-64 (lean), 65-79 (med), 80-89 (high), 90-100 (lock).
 */
async function handleMeCalibration(request, env) {
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    `SELECT
       p.type AS bet_type,
       CASE
         WHEN p.confidence_score IS NULL THEN 'unscored'
         WHEN p.confidence_score < 50 THEN '0-49'
         WHEN p.confidence_score < 65 THEN '50-64'
         WHEN p.confidence_score < 80 THEN '65-79'
         WHEN p.confidence_score < 90 THEN '80-89'
         ELSE '90-100'
       END AS bucket,
       COUNT(*) AS total,
       SUM(CASE WHEN s.outcome='W' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN s.outcome='L' THEN 1 ELSE 0 END) AS losses,
       SUM(CASE WHEN s.outcome='P' THEN 1 ELSE 0 END) AS pushes,
       COALESCE(SUM(s.units_delta), 0) AS units_delta,
       COALESCE(SUM(p.units), 0) AS units_risked,
       AVG(p.confidence_score) AS avg_score,
       AVG(p.edge_pct) AS avg_edge
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     LEFT JOIN settlements s ON s.pick_id = tp.pick_id
     WHERE tp.email = ?1
     GROUP BY bet_type, bucket
     ORDER BY bet_type, bucket`
  )
    .bind(email)
    .all();

  const rows = results.map((r) => ({
    bet_type: r.bet_type,
    bucket: r.bucket,
    total: r.total,
    settled: r.wins + r.losses + r.pushes,
    wins: r.wins,
    losses: r.losses,
    pushes: r.pushes,
    hit_rate:
      r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null,
    units_delta: r.units_delta,
    roi_pct:
      r.units_risked > 0 ? (r.units_delta / r.units_risked) * 100 : null,
    avg_score: r.avg_score,
    avg_edge: r.avg_edge,
  }));

  return json({ email, rows });
}

/**
 * POST /api/close-odds
 * Service endpoint — requires X-Settle-Secret header.
 * Body: { updates: [{pick_id, closing_odds}, ...] }
 * Run by the closing-line fetcher near first pitch of each game.
 */
async function handleCloseOdds(request, env) {
  const secret = request.headers.get('x-settle-secret');
  if (!env.SETTLE_SECRET || secret !== env.SETTLE_SECRET)
    return json({ error: 'forbidden' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const updates = body?.updates;
  if (!Array.isArray(updates))
    return json({ error: 'missing_updates' }, 400);

  const stmts = updates.map((u) =>
    env.DB.prepare(
      `UPDATE picks
       SET closing_odds = ?1, closed_at = unixepoch()
       WHERE pick_id = ?2`
    ).bind(String(u.closing_odds), u.pick_id)
  );

  const res = await env.DB.batch(stmts);
  return json({ ok: true, written: res.length });
}

/**
 * GET /api/leaderboard?window=7d|30d|all
 */
async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const win = url.searchParams.get('window') || '30d';
  let since = 0;
  if (win === '7d') since = Math.floor(Date.now() / 1000) - 7 * 86400;
  else if (win === '30d') since = Math.floor(Date.now() / 1000) - 30 * 86400;

  const { results } = await env.DB.prepare(
    `SELECT
       tp.email,
       COUNT(*) AS picks,
       SUM(CASE WHEN s.outcome='W' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN s.outcome='L' THEN 1 ELSE 0 END) AS losses,
       COALESCE(SUM(s.units_delta), 0) AS units_delta,
       COALESCE(SUM(p.units), 0) AS units_risked
     FROM tracked_picks tp
     JOIN picks p ON p.pick_id = tp.pick_id
     LEFT JOIN settlements s ON s.pick_id = tp.pick_id
     WHERE tp.tracked_at >= ?1
       AND s.outcome IN ('W','L','P')
     GROUP BY tp.email
     HAVING picks >= 3
     ORDER BY units_delta DESC
     LIMIT 20`
  )
    .bind(since)
    .all();

  // Anonymize: show handle = local-part-of-email, shortened
  const rows = results.map((r) => ({
    handle: r.email.split('@')[0].slice(0, 20),
    picks: r.picks,
    wins: r.wins,
    losses: r.losses,
    units_delta: r.units_delta,
    roi: r.units_risked > 0 ? (r.units_delta / r.units_risked) * 100 : 0,
  }));

  return json({ window: win, rows });
}

/**
 * GET /api/unsettled-picks?date=YYYY-MM-DD
 * Service endpoint — requires X-Settle-Secret header.
 * Returns picks tracked by anyone for a given date that have no settlement yet.
 */
async function handleUnsettledPicks(request, env) {
  const secret = request.headers.get('x-settle-secret');
  if (!env.SETTLE_SECRET || secret !== env.SETTLE_SECRET)
    return json({ error: 'forbidden' }, 403);

  const url = new URL(request.url);
  const date =
    url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.pick_id, p.pick_date, p.type, p.team, p.player,
            p.line, p.odds, p.units, p.description
     FROM picks p
     JOIN tracked_picks tp ON tp.pick_id = p.pick_id
     LEFT JOIN settlements s ON s.pick_id = p.pick_id
     WHERE p.pick_date = ?1 AND s.pick_id IS NULL`
  )
    .bind(date)
    .all();

  return json({ date, picks: results });
}

/**
 * POST /api/settle-batch
 * Service endpoint — requires X-Settle-Secret header.
 * Body: { settlements: [{pick_id, outcome, units_delta, note}, ...] }
 */
async function handleSettleBatch(request, env) {
  const secret = request.headers.get('x-settle-secret');
  if (!env.SETTLE_SECRET || secret !== env.SETTLE_SECRET)
    return json({ error: 'forbidden' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const settlements = body?.settlements;
  if (!Array.isArray(settlements))
    return json({ error: 'missing_settlements' }, 400);

  const stmts = settlements.map((s) =>
    env.DB.prepare(
      `INSERT INTO settlements (pick_id, outcome, units_delta, settled_at, grader_note)
       VALUES (?1, ?2, ?3, unixepoch(), ?4)
       ON CONFLICT(pick_id) DO UPDATE SET
         outcome=excluded.outcome,
         units_delta=excluded.units_delta,
         settled_at=unixepoch(),
         grader_note=excluded.grader_note`
    ).bind(s.pick_id, s.outcome, Number(s.units_delta), s.note || null)
  );

  const res = await env.DB.batch(stmts);
  return json({ ok: true, written: res.length });
}

// ── GitHub Actions dispatch helpers ──────────────────────────────────────────

async function dispatchWorkflow(workflowFile, inputs, env) {
  const token = env.GH_DISPATCH_TOKEN;
  const repo  = env.GH_REPO || 'Blb3D/mlb-probabilities';
  if (!token) return { ok: false, error: 'GH_DISPATCH_TOKEN not configured' };

  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'mlb-probabilities-worker/1.0',
      },
      body: JSON.stringify({ ref: 'master', inputs: inputs || {} }),
    }
  );

  if (r.status === 204) return { ok: true };
  const text = await r.text().catch(() => '');
  return { ok: false, error: `GitHub API ${r.status}: ${text.slice(0, 200)}` };
}

// CSRF mitigation for browser-callable POST endpoints.
// Enforce same-origin Origin when provided, and reject cross-site fetch contexts.
function checkSameOrigin(request) {
  const reqUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== reqUrl.origin) return false;
    } catch {
      return false;
    }
  }
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') {
    return false;
  }
  return true;
}

async function handleTriggerRegen(request, env) {
  if (!checkSameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);
  // ADMIN_EMAIL must be configured; if unset the endpoint is disabled to avoid
  // allowing any Cloudflare Access user to dispatch workflows.
  const admin = env.ADMIN_EMAIL;
  if (!admin) return json({ error: 'ADMIN_EMAIL not configured' }, 403);
  if (email !== admin) return json({ error: 'forbidden' }, 403);

  const url = new URL(request.url);
  const date = url.searchParams.get('date') || '';

  const result = await dispatchWorkflow('daily-regen.yml', date ? { date } : {}, env);
  if (!result.ok) return json({ error: result.error }, 502);
  return json({ ok: true, message: 'Regen workflow dispatched' });
}

async function handleTriggerSettle(request, env) {
  if (!checkSameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const email = getUserEmail(request);
  if (!email) return json({ error: 'unauthorized' }, 401);
  // ADMIN_EMAIL must be configured; if unset the endpoint is disabled to avoid
  // allowing any Cloudflare Access user to dispatch workflows.
  const admin = env.ADMIN_EMAIL;
  if (!admin) return json({ error: 'ADMIN_EMAIL not configured' }, 403);
  if (email !== admin) return json({ error: 'forbidden' }, 403);

  const url = new URL(request.url);
  const date    = url.searchParams.get('date') || '';
  const dry_run = url.searchParams.get('dry_run') === 'true' ? 'true' : 'false';

  const result = await dispatchWorkflow('settle.yml', { ...(date ? { date } : {}), dry_run }, env);
  if (!result.ok) return json({ error: result.error }, 502);
  return json({ ok: true, message: 'Settle workflow dispatched' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') return json({ ok: true, time: Date.now() });
    if (p === '/api/whoami') {
      const email = getUserEmail(request);
      return json({ email });
    }
    if (p === '/api/track' && request.method === 'POST')
      return handleTrack(request, env);
    if (p === '/api/untrack' && request.method === 'POST')
      return handleUntrack(request, env);
    if (p === '/api/pick-counts') return handlePickCounts(request, env);
    if (p === '/api/me/tracked') return handleMeTracked(request, env);
    if (p === '/api/me/stats') return handleMeStats(request, env);
    if (p === '/api/me/calibration') return handleMeCalibration(request, env);
    if (p === '/api/leaderboard') return handleLeaderboard(request, env);
    if (p === '/api/unsettled-picks') return handleUnsettledPicks(request, env);
    if (p === '/api/settle-batch' && request.method === 'POST')
      return handleSettleBatch(request, env);
    if (p === '/api/close-odds' && request.method === 'POST')
      return handleCloseOdds(request, env);
    if (p === '/api/trigger-regen' && request.method === 'POST')
      return handleTriggerRegen(request, env);
    if (p === '/api/trigger-settle' && request.method === 'POST')
      return handleTriggerSettle(request, env);

    if (p.startsWith('/api/'))
      return json({ error: 'not_found' }, 404);

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};
