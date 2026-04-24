# MLB Probabilities — Login + Bet Tracking Setup

Your dashboard now has the **UI for tracking picks** live. To turn on the actual tracking, you need to do two things on your end: (1) extend your Cloudflare API token with a few permissions so I can create the database, and (2) enable Cloudflare Zero Trust with your email allowlist.

Everything else — Worker API, /me page, /leaderboard page, daily settlement task — is already built and staged locally in `/sessions/funny-confident-faraday/mnt/outputs/`.

---

## What's live right now

| URL | What it shows |
|---|---|
| `/` | Games dashboard with **Track** buttons on every winner, total, and prop (buttons disabled until you sign in) |
| `/props` | Player props dashboard with Track buttons on every card |
| `/me` | Your personal tracked picks dashboard (currently shows "not signed in") |
| `/leaderboard` | Public leaderboard across all friends (empty until picks settle) |

The Track buttons currently show as disabled because `/api/whoami` returns 404 — that'll flip on automatically once the Worker + D1 are deployed.

---

## What you need to do

### Step 1: Extend your Cloudflare API token (2 minutes)

Go to https://dash.cloudflare.com/profile/api-tokens and edit the existing token you gave me (or create a new one). It needs these permissions on top of what it has now:

- **Account → D1 → Edit**
- **Account → Workers Scripts → Edit** (probably already there)
- **Account → Account Settings → Read**
- **User → User Details → Read**
- **User → Memberships → Read**

When you're done, paste the **same token value** back to me (or let me know if you rotated it — in which case send the new value).

### Step 2: Enable Cloudflare Zero Trust (5 minutes)

1. Go to https://one.dash.cloudflare.com/
2. If it's your first time, it'll ask you to create a "team" — pick any name like `blb3d` and choose the **Free** plan.
3. Go to **Access → Applications → Add an application**.
4. Choose **Self-hosted**.
5. Fill in:
   - **Application name**: `MLB Probabilities`
   - **Session duration**: 30 days
   - **Domain**: `mlb-probabilities.bbaker-939.workers.dev` (no path, just the domain)
6. Click **Next**. Under **Policies**, add one policy:
   - **Policy name**: `Allowed emails`
   - **Action**: Allow
   - **Rules**: Include → Emails → add each email you want to let in (yours + friends, ~5 to start)
7. Click **Next → Next → Add application**.
8. Go to **Settings → Authentication** in the Zero Trust sidebar and make sure **Google** is enabled as a login method (it's the default — just confirm).

Send me the list of emails you added, and I'll use them for testing.

### Step 3: Send me the settle secret

Pick any random string (32+ chars) that I can use as the service secret for the settlement task to authenticate itself to the Worker. Something like `openssl rand -hex 32` output works, or any password-generator string. I'll store it as an encrypted Worker secret.

---

## What happens after I have those three things

I'll run this sequence:

1. `wrangler d1 create mlb-tracking` → get the database ID
2. Update `wrangler.jsonc` with the D1 binding
3. `wrangler d1 execute mlb-tracking --file=schema.sql --remote` → create tables
4. `wrangler secret put SETTLE_SECRET` → store the shared secret
5. `wrangler deploy` → push the Worker + D1 binding
6. Smoke test: hit `/api/health`, `/api/whoami` (should return your email after you sign in), tap a Track button on a real pick

Then the next morning at 3am ET, the `mlb-settle-picks` scheduled task grades every pick from last night's slate and your `/me` page and the leaderboard start filling in.

---

## Files I built (all in `/sessions/funny-confident-faraday/mnt/outputs/`)

| File | Purpose |
|---|---|
| `src/worker.js` | Worker with all API endpoints (`/api/track`, `/api/untrack`, `/api/me/stats`, `/api/leaderboard`, `/api/pick-counts`, `/api/me/tracked`, `/api/unsettled-picks`, `/api/settle-batch`, `/api/whoami`, `/api/health`) |
| `schema.sql` | D1 schema: `users`, `picks`, `tracked_picks`, `settlements` |
| `MLB_Probabilities/me.html` | Personal ROI dashboard |
| `MLB_Probabilities/leaderboard.html` | Public leaderboard with 7d/30d/all-time windows |
| `MLB_Probabilities/index.html` | Updated with Track buttons on every pick |
| `MLB_Probabilities/props.html` | Updated with Track buttons on every prop card |
| `settle_picks.py` | Grader — parses MLB StatsAPI box scores and resolves picks to W/L/P/V |
| `wrangler.jsonc` | Currently in asset-only mode (temporary until D1 is ready) |

Also:
- New scheduled task `mlb-settle-picks` runs daily at 3:08am ET, grades yesterday's tracked picks.

---

## How Track → Settle works end-to-end

1. You open `/props` and tap **Track** on a prop card. JS posts `{pick_id, player, odds, units, ...}` to `/api/track`.
2. The Worker reads your email from `Cf-Access-Authenticated-User-Email` (injected by Cloudflare Access) and writes a `tracked_picks` row.
3. Game ends. Overnight, the 3am ET scheduled task hits `/api/unsettled-picks?date=YYYY-MM-DD`, gets a list of all picks tracked by anyone for yesterday that haven't been graded.
4. For each game, the task pulls the MLB StatsAPI box score and grades each pick (W/L/P/V) using `settle_picks.py`.
5. Results get POSTed to `/api/settle-batch` which writes `settlements` rows.
6. Next time you open `/me`, your units, ROI, and win rate recalc from the joined `tracked_picks × settlements` view.

---

## Privacy notes

- Everyone signed in can see the leaderboard (with handles = email local-parts).
- No one else can see your individual picks.
- Pick history is visible only to you on `/me`.
- Emails are stored but never exposed beyond the local-part on the leaderboard.
