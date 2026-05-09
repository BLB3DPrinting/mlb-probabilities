# SportsBotv2

MLB Over/Under projection bot with park-factor and weather-physics modeling.

## What it does

Pulls live data from the MLB Stats API, The Odds API (FanDuel totals), and OpenWeatherMap, then runs a layered statistical model to project total runs for every MLB game on a given date and compare against the market line.

The model:

- **Pitcher rating** — FIP/ERA blend (65/35) with home-road splits, recent-form weighting, and partial-data blending against league average
- **Offensive rating** — runs-per-PA with home-road splits and 14-day hot/cold adjustment, clamped at ±15%
- **Park factors** — per-stadium run environment, plus altitude adjustment for Coors
- **Weather** — wind direction relative to center-field bearing, temperature, humidity, all skipped for domed stadiums
- **Tactician layer** — 3rd-time-through penalty, pitch-count fatigue, rest days, season workload decay, platoon splits, barrel rate, and an air-density carry calculation

Picks are issued only when the model's edge against the market line exceeds the configured threshold (default 0.5 runs).

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/SportsBotv2.git
cd SportsBotv2
cp .env.example .env
# Edit .env with your API keys
node src/index.js
```

Run for a specific date:

```bash
node src/index.js 2026-04-25
```

## API keys

You need two free-tier API keys:

- **The Odds API** — [the-odds-api.com](https://the-odds-api.com) (500 requests/month free)
- **OpenWeatherMap** — [openweathermap.org](https://openweathermap.org) (1,000 requests/day free)

Add them to `.env`:

```
ODDS_API_KEY=your_key_here
OPENWEATHER_API_KEY=your_key_here
```

## Project structure

```
SportsBotv2/
├── .env.example              # API key template
├── .gitignore
├── config/
│   ├── defaults.json         # Tunable model constants
│   └── teams.json            # Teams, stadiums, park factors
├── src/
│   ├── api/
│   │   ├── client.js         # Fetch helpers with retry + .env loader
│   │   ├── schedule.js       # MLB schedule
│   │   ├── pitcher.js        # Pitcher stats + rest days + handedness
│   │   ├── team.js           # Team hitting stats
│   │   ├── odds.js           # FanDuel totals lines
│   │   ├── weather.js        # OpenWeatherMap with rate limiting
│   │   └── roster.js         # Roster + platoon splits
│   ├── model/
│   │   ├── fip.js            # Pitcher rating
│   │   ├── offense.js        # Offensive multiplier
│   │   ├── park.js           # Park factor + altitude
│   │   ├── weather.js        # Wind/temp/humidity adjustments
│   │   ├── tactician.js      # Edge calculator (TTO, fatigue, physics)
│   │   └── project.js        # Final projection engine
│   ├── output/
│   │   ├── console.js        # Terminal table
│   │   ├── tactician.js      # Tactician breakdown
│   │   └── json.js           # JSON file output
│   └── index.js              # Entry point
└── data/
    └── results/              # Daily projection JSONs (gitignored)
```

## Dependencies

**None.** Node 18+ has `fetch` built in. `.env` parsing is hand-rolled in `src/api/client.js`. No `npm install` required.

## Configuration

All tunable constants live in `config/defaults.json`. Most-touched:

| Setting              | Default | Purpose                                 |
|----------------------|---------|-----------------------------------------|
| `edgeThreshold`      | 0.5     | Minimum run edge to issue a pick        |
| `fipWeight`          | 0.65    | FIP weight in pitcher blend             |
| `eraWeight`          | 0.35    | ERA weight in pitcher blend             |
| `minPitcherIP`       | 30      | Full-data threshold                     |
| `minPitcherIPPartial`| 10      | Partial-data threshold (blends with LG) |
| `recentFormWeight`   | 1.5     | Weight on most recent 5 starts          |
| `windOutRunsPerMPH`  | 0.10    | Wind blowing out → runs                 |
| `windInRunsPerMPH`   | 0.08    | Wind blowing in → runs                  |

## Output

Console output is a formatted table with matchup, model projection, market line, edge, pick, and confidence. JSON output is written to `data/results/YYYY-MM-DD.json` with the full breakdown for later analysis.

## License

Private. Do not redistribute.
