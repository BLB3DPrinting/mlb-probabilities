# Settle Picks — Daily 3:08am ET Scheduled Task

This is the SKILL.md the scheduled settle task should use. It replaces any
SKILL.md that talks about CF_TOKEN or direct D1 queries. The new flow is
HTTP-only: this script POSTs to the Worker, the Worker writes to D1.

## What this task does

Every morning at 3:08am ET it grades yesterday's tracked MLB picks and
writes the results to D1 via the Worker's `/api/settle-batch` endpoint.

## Required environment / files

The task **must abort cleanly** with a report (no D1 writes, no MLB API
calls) if any of these are missing:

1. `settle_picks.py` — the grading script. Should be in the working folder.
   If missing, abort.
2. `SETTLE_SECRET` — env var, value of the Worker's `SETTLE_SECRET` secret.
3. `CF_ACCESS_CLIENT_ID` — env var, Cloudflare Access service token id.
4. `CF_ACCESS_CLIENT_SECRET` — env var, Cloudflare Access service token secret.

If any of these are missing, the script will print "FATAL: missing env
vars: ..." to stderr and exit 2. **Do not try to scaffold around it. Do
not try to find a Cloudflare API token. Do not query D1 directly.** Just
report which env vars are missing and stop.

## What this task should NEVER do

- Use `CF_TOKEN` or any Cloudflare account API token. The Worker mediates
  all D1 access. Direct D1 queries from this script are forbidden.
- Modify `wrangler.jsonc`, `src/worker.js`, or any of the static HTML in
  `MLB_Probabilities/`. The morning probabilities task owns the dashboard.
  This task is read-and-grade only.
- Run any `wrangler` command. This script uses plain HTTPS requests through
  Cloudflare Access — it doesn't need wrangler at all.

## Run command

```bash
cd /path/to/working/folder
python3 settle_picks.py
```

For testing without writing to D1:

```bash
python3 settle_picks.py --dry-run
```

To re-grade a specific date:

```bash
python3 settle_picks.py --date 2026-04-24
```

## What the script handles automatically

- **Backfill window:** if a previous run was missed, this run automatically
  picks up the prior 2 days of unsettled picks. So a single missed 3am
  alarm never loses data.
- **Postponed games:** graded as `V` (void), 0 units delta.
- **In-progress games:** silently skipped this run, retried on the next.
- **Push outcomes:** integer-line pushes (e.g. exact total of 8 on O/U 8.0)
  graded as `P`, 0 units delta.

## Expected output (success)

```
  2026-04-24: 12 unsettled picks to grade
  2026-04-24: graded 11  W=4 L=6 P=1 V=0  net -1.50u  (skipped 1 — game not yet final)
OK — wrote 11 settlements to D1.
```

## Expected output (clean abort, missing creds)

```
FATAL: missing env vars: SETTLE_SECRET, CF_ACCESS_CLIENT_ID
Skill must abort cleanly. No D1 queries issued, no settlements written.
```

Exit code 2 = missing creds. Exit code 3 = HTTP failure on settle-batch
POST. Exit code 0 = success or "nothing to settle."

## How to set up the env vars

See `ACCESS_SERVICE_TOKEN_SETUP.md` in this folder for the one-time
Cloudflare Access service token setup. After that, `SETTLE_SECRET` lives
on the Worker (set once via `wrangler secret put SETTLE_SECRET`) and the
two `CF_ACCESS_*` env vars get configured on the scheduled task runner.