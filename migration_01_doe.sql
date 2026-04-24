-- Migration 01 — Design of Experiments instrumentation
-- Adds confidence-component fields + closing-odds capture to picks.
-- Run via: wrangler d1 execute mlb-tracking --file=migration_01_doe.sql --remote

-- Composite 0-100 score written by the morning generator.
-- Formula is transparent: round(((edge_component + weather_cert + lineup_cert) / 3) * 100)
-- where edge_component = clamp(edge_pct * 10, 0, 1)
ALTER TABLE picks ADD COLUMN confidence_score INTEGER;

-- Model probability minus de-vigged market probability, as a decimal.
-- Positive = we think this hits more than the market implies. Can be negative.
ALTER TABLE picks ADD COLUMN edge_pct REAL;

-- 0.0 = tentative forecast / dome unknown, 1.0 = confirmed conditions at first pitch.
ALTER TABLE picks ADD COLUMN weather_cert REAL;

-- 0.0 = probables TBD / key bat GTD, 1.0 = lineup card posted, no scratches.
ALTER TABLE picks ADD COLUMN lineup_cert REAL;

-- Bet-type-specific factors as JSON so we can add fields without further migrations.
-- HR example: {"park_hr_factor":1.08,"pitcher_hr9":1.9,"barrel_l15":0.14,"platoon":"L-vs-R"}
-- Total example: {"park_run_factor":0.94,"combined_fip":3.20,"wind":"in 12mph","temp_f":55}
-- ML example: {"pitcher_xera_edge":0.45,"bullpen_era_diff":-0.7,"lineup_ops_diff":0.02}
ALTER TABLE picks ADD COLUMN factors_json TEXT;

-- Closing odds captured by the closing-line fetcher near first pitch.
-- Stored as American odds string ("-110", "+265") to match `odds`.
ALTER TABLE picks ADD COLUMN closing_odds TEXT;

-- When closing_odds was captured (unixepoch).
ALTER TABLE picks ADD COLUMN closed_at INTEGER;

-- Helpful index for calibration queries (bucket by confidence_score).
CREATE INDEX IF NOT EXISTS idx_picks_confidence ON picks(confidence_score);
