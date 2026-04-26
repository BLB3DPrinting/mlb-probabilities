#!/usr/bin/env python3
"""Settle yesterday's tracked MLB picks via Worker endpoints.

Runs in the daily 3am ET scheduled task. Architecture:

  this script ──HTTP──▶ Cloudflare Access ──▶ Worker ──▶ D1
                       (service token bypass)

It does NOT need a Cloudflare API token (CF_TOKEN). All it needs is:
  - SETTLE_SECRET            — value of the Worker's secret (X-Settle-Secret header)
  - CF_ACCESS_CLIENT_ID      — Cloudflare Access service token id
  - CF_ACCESS_CLIENT_SECRET  — Cloudflare Access service token secret

Flow:
  1. GET /api/unsettled-picks?date=YYYY-MM-DD → list of unsettled picks
     (includes a 2-day backfill: yesterday + the prior 2 days, so a missed
     run never loses picks)
  2. For each pick, look up the game in MLB StatsAPI and grade it.
  3. POST /api/settle-batch with the settlements list.
  4. Print a summary report.

Grading rules by type:
  - ml (moneyline): winner of the game = W, loser = L
  - total (over/under N.5): sum of both teams' runs vs the line. Integer line + exact = P
  - prop_hr / hr: did the player hit >= line HRs
  - prop_hits: hits vs line
  - prop_ks: pitcher strikeouts vs line
  - prop_tb: total bases vs line
  - prop_hrr: H+R+RBI combined vs line
Postponed/rainout = V (void, 0 units change).

Run manually:
  SETTLE_SECRET=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
    python3 settle_picks.py [--date YYYY-MM-DD] [--dry-run]
"""
import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta

MLB_API = "https://statsapi.mlb.com/api/v1"
WORKER_BASE = os.environ.get(
    "WORKER_BASE",
    "https://mlb-probabilities.bbaker-939.workers.dev",
)
BACKFILL_DAYS = 2  # also re-attempt picks from prior N days that are still unsettled


# ───────────────────────── Auth headers ──────────────────────────

def auth_headers():
    """Headers for talking to the Worker through Cloudflare Access."""
    secret = os.environ.get("SETTLE_SECRET")
    cf_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    cf_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    missing = [k for k, v in [
        ("SETTLE_SECRET", secret),
        ("CF_ACCESS_CLIENT_ID", cf_id),
        ("CF_ACCESS_CLIENT_SECRET", cf_secret),
    ] if not v]
    if missing:
        print(f"FATAL: missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("Skill must abort cleanly. No D1 queries issued, no settlements written.", file=sys.stderr)
        sys.exit(2)
    return {
        "CF-Access-Client-Id": cf_id,
        "CF-Access-Client-Secret": cf_secret,
        "X-Settle-Secret": secret,
        "Content-Type": "application/json",
        # Cloudflare's bot-fight mode 403s requests with the default
        # Python-urllib UA (error 1010). Anything that looks vaguely like a
        # real client gets through — service-token auth still applies.
        "User-Agent": "mlb-settle-task/1.0 (+https://mlb-probabilities.bbaker-939.workers.dev)",
    }


def http_json(method: str, path: str, body=None, headers=None):
    """Fire a JSON HTTP request and parse the response."""
    url = f"{WORKER_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")[:500]
        print(f"HTTP {e.code} {method} {path}\n  body: {body_text}", file=sys.stderr)
        raise


# ───────────────────────── Payout math ──────────────────────────

def american_payout(odds: str, stake_units: float) -> float:
    """Net units for a WIN at given American odds. +150 1u → +1.5u. -120 1u → +0.833u."""
    try:
        n = int(str(odds).lstrip("+"))
    except Exception:
        return 0.0
    if n > 0:
        return stake_units * (n / 100.0)
    return stake_units * (100.0 / abs(n))


# ───────────────────────── Grader ──────────────────────────

_LINE_RE = re.compile(r"(?:over|under|\bo\b|\bu\b)\s*(\d+(?:\.\d+)?)", re.IGNORECASE)


def extract_line_from_desc(desc):
    """Fallback: pull the numeric line out of the description text.
    Matches "Over 4.5", "Under 7.5", "U 7.5", "O 8.5", etc."""
    if not desc:
        return None
    m = _LINE_RE.search(desc)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def grade_pick(pick, box):
    """Return (outcome, units_delta, note) given a pick and its game's box dict."""
    ptype = pick["type"]
    stake = float(pick.get("units", 0))
    odds = pick.get("odds", "+0")
    line = pick.get("line")
    # Fallback: many props arrive with line=null but the line in the description.
    if line is None:
        line = extract_line_from_desc(pick.get("description"))

    if box.get("status") in ("Postponed", "Cancelled", "Suspended"):
        return ("V", 0.0, "Game postponed/cancelled")

    # Moneyline
    if ptype == "ml":
        winner = box.get("winner_abbrev")
        team = pick.get("team")
        if winner is None or team is None:
            return ("V", 0.0, "Missing winner data")
        if winner == team:
            return ("W", american_payout(odds, stake), f"{team} won")
        return ("L", -stake, f"{team} lost")

    # Totals
    if ptype == "total":
        total = box.get("away_runs", 0) + box.get("home_runs", 0)
        desc = (pick.get("description") or "").lower()
        is_over = " o " in desc or desc.endswith(" o") or "over" in desc
        if line is None:
            return ("V", 0.0, "Missing line")
        if total > line:
            return (
                "W" if is_over else "L",
                american_payout(odds, stake) if is_over else -stake,
                f"Total {total} vs {line}",
            )
        if total < line:
            return (
                "W" if not is_over else "L",
                -stake if is_over else american_payout(odds, stake),
                f"Total {total} vs {line}",
            )
        # Push: line was an integer and total matches exactly
        return ("P", 0.0, f"Push at {total}")

    # Player props
    players = box.get("players", {})
    player = pick.get("player")
    if not player or player not in players:
        return ("V", 0.0, f"No stat line for {player}")
    p = players[player]

    desc = (pick.get("description") or "").lower()
    is_under = "under" in desc

    def grade_stat(stat_val, line_val):
        if line_val is None:
            return ("V", 0.0)
        # Integer line + exact match = push
        if stat_val == line_val and float(line_val) == int(line_val):
            return ("P", 0.0)
        hit = (stat_val < line_val) if is_under else (stat_val > line_val)
        if hit:
            return ("W", american_payout(odds, stake))
        return ("L", -stake)

    if ptype in ("prop_hr", "hr"):
        hr = p.get("hr", 0)
        outcome, delta = grade_stat(hr, line if line is not None else 0.5)
        return (outcome, delta, f"{hr} HR")
    if ptype == "prop_hits":
        h = p.get("hits", 0)
        outcome, delta = grade_stat(h, line if line is not None else 0.5)
        return (outcome, delta, f"{h} H")
    if ptype == "prop_ks":
        k = p.get("k", 0)
        outcome, delta = grade_stat(k, line if line is not None else 0.5)
        return (outcome, delta, f"{k} K")
    if ptype == "prop_tb":
        tb = p.get("tb", 0)
        outcome, delta = grade_stat(tb, line if line is not None else 0.5)
        return (outcome, delta, f"{tb} TB")
    if ptype == "prop_hrr":
        hrr = p.get("hits", 0) + p.get("runs", 0) + p.get("rbi", 0)
        outcome, delta = grade_stat(hrr, line if line is not None else 0.5)
        return (outcome, delta, f"{hrr} H+R+RBI")

    return ("V", 0.0, f"Unknown type {ptype}")


# ───────────────────────── MLB StatsAPI ──────────────────────────

def fetch_schedule(iso_date: str):
    url = f"{MLB_API}/schedule?sportId=1&date={iso_date}"
    with urllib.request.urlopen(url) as r:
        data = json.load(r)
    games = []
    for day in data.get("dates", []):
        for g in day.get("games", []):
            games.append(g)
    return games


def fetch_boxscore(gamePk: int):
    url = f"{MLB_API}/game/{gamePk}/boxscore"
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def fetch_linescore(gamePk: int):
    url = f"{MLB_API}/game/{gamePk}/linescore"
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def build_box_lookup(iso_date: str):
    """Build {(away_abbrev, home_abbrev): box_dict} for all games on a date."""
    games = fetch_schedule(iso_date)
    out = {}
    for g in games:
        pk = g["gamePk"]
        status = g.get("status", {}).get("detailedState", "")
        try:
            box = fetch_boxscore(pk)
            line = fetch_linescore(pk)
        except Exception:
            continue
        away_abbrev = box["teams"]["away"]["team"].get("abbreviation")
        home_abbrev = box["teams"]["home"]["team"].get("abbreviation")
        away_runs = line.get("teams", {}).get("away", {}).get("runs", 0)
        home_runs = line.get("teams", {}).get("home", {}).get("runs", 0)
        winner = None
        if away_runs > home_runs:
            winner = away_abbrev
        elif home_runs > away_runs:
            winner = home_abbrev
        # Player stats
        players = {}
        for side in ("away", "home"):
            for _, pdata in box["teams"][side].get("players", {}).items():
                name = pdata.get("person", {}).get("fullName")
                if not name:
                    continue
                stats = pdata.get("stats", {})
                bat = stats.get("batting", {})
                pit = stats.get("pitching", {})
                players[name] = {
                    "hits": bat.get("hits", 0),
                    "hr": bat.get("homeRuns", 0),
                    "rbi": bat.get("rbi", 0),
                    "runs": bat.get("runs", 0),
                    "tb": bat.get("totalBases", 0),
                    "k": pit.get("strikeOuts", 0) if pit else bat.get("strikeOuts", 0),
                }
        out[(away_abbrev, home_abbrev)] = {
            "status": status,
            "winner_abbrev": winner,
            "away_runs": away_runs,
            "home_runs": home_runs,
            "players": players,
        }
    return out


def match_box_to_pick(pick, boxes):
    """Figure out which game a pick belongs to based on pick_id or team."""
    pid = pick["pick_id"]
    # pick_id formats:
    #   2026-04-21:ml:HOU-CLE:CLE
    #   2026-04-21:total:HOU-CLE:u-8.5
    #   2026-04-21:prop:HOU-CLE:parker-messick:k-over-5-5
    #   2026-04-21:prop:NYY:aaron-judge:hr-0-5         (single team — try both sides)
    parts = pid.split(":")
    if len(parts) >= 3 and "-" in parts[2]:
        # may be "AWAY-HOME" or could be a single team like "RED-SOX"; try both interpretations
        candidates = [parts[2].split("-", 1)]
    else:
        candidates = []
    for away, home in candidates:
        b = boxes.get((away, home))
        if b is not None:
            return b
    # Fallback: search by pick.team in either slot
    team = pick.get("team")
    if team:
        for (a, h), b in boxes.items():
            if team in (a, h):
                return b
    return None


# ───────────────────────── Main ──────────────────────────

def settle_for_date(iso_date: str, picks: list):
    """Build box lookup for date, grade each pick. Returns settlements list."""
    boxes = build_box_lookup(iso_date)
    out = []
    for p in picks:
        box = match_box_to_pick(p, boxes)
        if box is None:
            continue  # try again on the next run
        outcome, delta, note = grade_pick(p, box)
        out.append({
            "pick_id": p["pick_id"],
            "outcome": outcome,
            "units_delta": round(delta, 4),
            "note": note,
        })
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default yesterday ET)")
    parser.add_argument("--dry-run", action="store_true", help="Print settlements but do not POST to /api/settle-batch")
    args = parser.parse_args()

    target = (
        datetime.strptime(args.date, "%Y-%m-%d").date()
        if args.date
        else (date.today() - timedelta(days=1))
    )

    headers = auth_headers()

    # Pull unsettled picks for the target date AND the prior BACKFILL_DAYS days.
    # This way a single missed run never loses picks.
    by_date = {}
    for d_offset in range(BACKFILL_DAYS + 1):
        d = (target - timedelta(days=d_offset)).isoformat()
        try:
            resp = http_json("GET", f"/api/unsettled-picks?date={d}", headers=headers)
        except Exception as e:
            print(f"  ! failed to fetch /api/unsettled-picks?date={d}: {e}", file=sys.stderr)
            continue
        picks = resp.get("picks", [])
        if picks:
            by_date[d] = picks
            print(f"  {d}: {len(picks)} unsettled picks to grade")

    if not by_date:
        print("Nothing to settle — no unsettled picks in window.")
        return 0

    # Grade each date's picks against that date's box scores.
    all_settlements = []
    for iso_date, picks in by_date.items():
        settlements = settle_for_date(iso_date, picks)
        all_settlements.extend(settlements)
        wins = sum(1 for s in settlements if s["outcome"] == "W")
        losses = sum(1 for s in settlements if s["outcome"] == "L")
        pushes = sum(1 for s in settlements if s["outcome"] == "P")
        voids = sum(1 for s in settlements if s["outcome"] == "V")
        units = sum(s["units_delta"] for s in settlements)
        skipped = len(picks) - len(settlements)
        print(
            f"  {iso_date}: graded {len(settlements)}  "
            f"W={wins} L={losses} P={pushes} V={voids}  "
            f"net {units:+.2f}u  (skipped {skipped} — game not yet final)"
        )

    if not all_settlements:
        print("No settlements ready (all games still in progress?).")
        return 0

    if args.dry_run:
        print(json.dumps(all_settlements, indent=2))
        print(f"DRY RUN: would have written {len(all_settlements)} settlements.")
        return 0

    # Push to Worker
    try:
        result = http_json(
            "POST",
            "/api/settle-batch",
            body={"settlements": all_settlements},
            headers=headers,
        )
    except Exception as e:
        print(f"FATAL: settle-batch POST failed: {e}", file=sys.stderr)
        return 3

    print(f"OK — wrote {result.get('written', '?')} settlements to D1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())