-- MLB Probabilities tracking schema
-- Run via: wrangler d1 execute mlb-tracking --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS picks (
  pick_id TEXT PRIMARY KEY,          -- e.g. "2026-04-21:NYY-judge-HR"
  pick_date TEXT NOT NULL,           -- YYYY-MM-DD
  type TEXT NOT NULL,                -- 'straight' | 'parlay' | 'hr' | 'prop_hit' | 'prop_tb' | 'ml' | 'total' | etc
  team TEXT,                         -- primary team abbreviation (for parlays, the first leg's team)
  player TEXT,                       -- player name if prop
  line REAL,                         -- prop line (e.g. 1.5 hits, 0.5 HR)
  odds TEXT NOT NULL,                -- American odds as string: "+150", "-120"
  units REAL NOT NULL,               -- units risked (from the unit-sizing rubric)
  description TEXT                   -- human-readable summary for history views
);

CREATE INDEX IF NOT EXISTS idx_picks_date ON picks(pick_date);

CREATE TABLE IF NOT EXISTS tracked_picks (
  email TEXT NOT NULL,
  pick_id TEXT NOT NULL,
  tracked_at INTEGER NOT NULL,
  PRIMARY KEY (email, pick_id),
  FOREIGN KEY (email) REFERENCES users(email),
  FOREIGN KEY (pick_id) REFERENCES picks(pick_id)
);

CREATE INDEX IF NOT EXISTS idx_tp_email ON tracked_picks(email);
CREATE INDEX IF NOT EXISTS idx_tp_pick ON tracked_picks(pick_id);
CREATE INDEX IF NOT EXISTS idx_tp_date ON tracked_picks(tracked_at);

CREATE TABLE IF NOT EXISTS settlements (
  pick_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,             -- 'W' | 'L' | 'P' (push) | 'V' (void / postponed)
  units_delta REAL NOT NULL,         -- + for wins (payout minus stake), - for losses (negative stake), 0 for push/void
  settled_at INTEGER NOT NULL,
  grader_note TEXT,                  -- optional explanation (which leg failed, final score, etc)
  FOREIGN KEY (pick_id) REFERENCES picks(pick_id)
);

CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements(settled_at);
