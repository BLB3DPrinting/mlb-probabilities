#!/usr/bin/env python3
"""Settle yesterday's tracked MLB picks.

This runs in the daily scheduled task at ~3am ET. It:
 1. Reads the D1 DB to find all unsettled picks from yesterday (and earlier
    still-pending ones, in case of late/postponed games).
 2. Pulls MLB StatsAPI results for those games.
 3. Grades each pick: W (win) / L (loss) / P (push) / V (void/rained out).
 4. Computes units_delta using American odds → payout math.
 5. Writes to the settlements table.

Grading rules by type:
  - ml (moneyline): winner of the game = W, loser = L
  - total (over/under N.5): sum of both teams' runs vs the line. If integer line, exact = P
  - prop_hr: did the player hit >= 1 HR
  - prop_hits: total hits vs line (integer line exact = P)
  - prop_ks: pitcher strikeouts vs line
  - prop_tb: total bases vs line
  - prop_hrr / prop_hits: H+R+RBI combined vs line
Postponed/rainout = V (void, 0 units change).

Run manually:
  CF_API_TOKEN=... DB_ID=... python3 settle_picks.py [--date YYYY-MM-DD]

The Worker exposes an internal endpoint /api/settle-batch that takes a list of
settlements and writes them in a single transaction.
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta

MLB_API = "https://statsapi.mlb.com/api/v1"


def american_payout(odds: str, stake_units: float) -> float:
    """Return the net units change for a WIN at given American odds.
    +150, 1.0u stake → +1.5u. -120, 1.0u → +0.833u. Loss = -stake."""
    try:
        n = int(odds.lstrip("+"))
    except Exception:
        return 0.0
    if n > 0:
        return stake_units * (n / 100.0)
    else:
        return stake_units * (100.0 / abs(n))


def grade_pick(pick, box):
    """Given a pick dict and a box score dict, return (outcome, delta, note).
    outcome is 'W', 'L', 'P', or 'V'. delta is unit change."""
    ptype = pick["type"]
    stake = float(pick.get("units", 0))
    odds = pick.get("odds", "+0")
    line = pick.get("line")

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
            return ("W" if is_over else "L", american_payout(odds, stake) if is_over else -stake, f"Total {total} vs {line}")
        if total < line:
            return ("W" if not is_over else "L", -stake if is_over else american_payout(odds, stake), f"Total {total} vs {line}")
        return ("P", 0.0, f"Push at {total}")

    # Player props: we need player stat lines
    players = box.get("players", {})  # map name -> stat dict
    player = pick.get("player")
    if not player or player not in players:
        return ("V", 0.0, f"No stat line for {player}")
    p = players[player]

    def grade_stat(stat_val, line_val, over=True):
        if line_val is None:
            return ("V", 0.0)
        if stat_val == line_val and line_val == int(line_val):
            return ("P", 0.0)
        hit = stat_val > line_val if over else stat_val < line_val
        if hit:
            return ("W", american_payout(odds, stake))
        return ("L", -stake)

    desc = (pick.get("description") or "").lower()
    is_under = "under" in desc

    if ptype == "prop_hr":
        hr = p.get("hr", 0)
        outcome, delta = grade_stat(hr, line or 0.5, over=not is_under)
        return (outcome, delta, f"{hr} HR")
    if ptype == "prop_hits":
        h = p.get("hits", 0)
        outcome, delta = grade_stat(h, line or 0.5, over=not is_under)
        return (outcome, delta, f"{h} H")
    if ptype == "prop_ks":
        k = p.get("k", 0)
        outcome, delta = grade_stat(k, line or 0.5, over=not is_under)
        return (outcome, delta, f"{k} K")
    if ptype == "prop_tb":
        tb = p.get("tb", 0)
        outcome, delta = grade_stat(tb, line or 0.5, over=not is_under)
        return (outcome, delta, f"{tb} TB")
    if ptype == "prop_hrr":
        hrr = p.get("hits", 0) + p.get("runs", 0) + p.get("rbi", 0)
        outcome, delta = grade_stat(hrr, line or 0.5, over=not is_under)
        return (outcome, delta, f"{hrr} H+R+RBI")

    return ("V", 0.0, f"Unknown type {ptype}")


def fetch_schedule(iso_date: str):
    """Returns list of gamePks for a date."""
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
    """Build { gamePk: box_dict } for all games on date."""
    games = fetch_schedule(iso_date)
    out = {}
    for g in games:
        pk = g["gamePk"]
        status = g.get("status", {}).get("detailedState", "")
        try:
            box = fetch_boxscore(pk)
            line = fetch_linescore(pk)
        except Exception as e:
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
        # Collect player stats
        players = {}
        for side in ("away", "home"):
            side_players = box["teams"][side].get("players", {})
            for pid, pdata in side_players.items():
                name = pdata.get("person", {}).get("fullName")
                if not name:
                    continue
                s = pdata.get("stats", {})
                bat = s.get("batting", {})
                pit = s.get("pitching", {})
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
    # pick_id format examples:
    #   2026-04-21:ml:HOU-CLE:CLE
    #   2026-04-21:total:HOU-CLE:u-8.5
    #   2026-04-21:prop:HOU-CLE:parker-messick:k-over-5-5
    #   2026-04-21:prop:NYY:aaron-judge:hr-0-5       (props.html doesn't have game slug)
    parts = pid.split(":")
    if len(parts) >= 3 and "-" in parts[2] and parts[1] in ("ml", "total", "prop"):
        away, home = parts[2].split("-", 1)
        return boxes.get((away, home))
    # Fallback: try by team
    team = pick.get("team")
    if team:
        for (a, h), b in boxes.items():
            if team in (a, h):
                return b
    return None


def settle_picks(iso_date: str, picks: list):
    """Grade a batch of picks. Returns list of settlement dicts."""
    boxes = build_box_lookup(iso_date)
    results = []
    for p in picks:
        box = match_box_to_pick(p, boxes)
        if box is None:
            continue  # skip for now, try again tomorrow
        outcome, delta, note = grade_pick(p, box)
        results.append({
            "pick_id": p["pick_id"],
            "outcome": outcome,
            "units_delta": delta,
            "note": note,
        })
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default yesterday)")
    parser.add_argument("--picks-json", default=None, help="Path to JSON file with picks to grade (for testing)")
    args = parser.parse_args()

    iso = args.date or (date.today() - timedelta(days=1)).isoformat()

    if args.picks_json:
        with open(args.picks_json) as f:
            picks = json.load(f)
    else:
        print("Direct DB read not implemented — use the Worker /api/settle-pending endpoint instead.")
        sys.exit(0)

    settlements = settle_picks(iso, picks)
    print(json.dumps(settlements, indent=2))


if __name__ == "__main__":
    main()
