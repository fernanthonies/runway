# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Runway" — a single-page personal budget tracker. FastAPI + stdlib sqlite3 backend, vanilla HTML/CSS/JS frontend (no build step, no npm). Single user, no auth. Docker is the primary way to run it.

## Commands

```bash
# Run (primary): http://localhost:8100 — host port is 8100 because 8000 is
# taken by another container (backlog-board) on this machine
docker compose up -d --build     # or: just start

# The justfile wraps compose: just start / stop / restart / logs.
# `restart` does not pick up code or static changes — only `start` rebuilds.

# Local dev (system python3 is 3.9 — too old; venv uses python3.13).
# Pick a free port: :8000 is taken on this machine, :8100 by the container.
.venv/bin/uvicorn main:app --reload --port 8123
# If .venv is missing/broken: python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt

# Exercising destructive endpoints (POST /api/reset): point BUDGET_DB at a
# copy so the real log is never the target.
cp data/budget.db /tmp/probe.db
BUDGET_DB=/tmp/probe.db .venv/bin/uvicorn main:app --port 8123
```

There are no tests or linters configured. Verify changes by exercising the API with curl (see `GET /api/summary`) and loading the page in a browser.

Frontend behaviour that hinges on real events — autocomplete picks, blur, the delete confirmation — can be driven in headless Chrome over the DevTools protocol (`--headless=new --remote-debugging-port=…`, then `Runtime.evaluate`). Two traps worth knowing: an unfocused headless page fires no `blur`/`focus` events at all unless you enable `Emulation.setFocusEmulationEnabled`, and `Page.navigate` uses the HTTP cache, so a stale `index.html` can keep pointing at a stale `app.js` (see caching below).

## Architecture

Two Python files plus static assets:

- `db.py` — SQLite layer. Opens a new connection per call. DB path comes from the `BUDGET_DB` env var (set to `/data/budget.db` in Docker, defaults to `./data/budget.db` locally).
- `main.py` — FastAPI routes under `/api/*`, serves `static/index.html` at `/`. All budget math lives in `build_summary()`.
- `static/app.js` — all frontend logic for all three views; `static/style.css` — the dark "instrument panel" theme.
- `static/chart.umd.min.js` — Chart.js, vendored rather than loaded from a CDN, so the stats page works offline.
- `widget/runway-widget.js` — an iOS home/lock screen widget for the Scriptable app (not part of the server). See `widget/README.md`.

Core design decisions that everything depends on:

- **Resets are computed, never scheduled.** There is no cron/scheduler and no stored "remaining balance". Every request derives remaining budgets from the transaction log and today's date: monthly window = current calendar month; weekly window = most recent Sunday through Saturday. The two windows are independent (a week straddling the 1st draws from both months' views — intentional). Weekly allowance is `monthly_budget / 4`. Because of this, the container's `TZ` (set in docker-compose.yml) matters: it determines when "today" rolls over.
- **Money is integer cents in the DB and dollars (floats) at the API boundary.** Conversion happens only in `main.py` (`dollars_to_cents` / `cents_to_dollars`). Don't do arithmetic on dollar floats.
- **Merchants and categories are auto-upserted**, unique case-insensitively (`COLLATE NOCASE`), when a transaction is posted. They're never deleted by ordinary transaction edits, so they persist as autocomplete suggestions even after their transactions are removed — only a full reset clears them.
- **Backdating**: transactions have both `txn_date` (user-settable, drives all budget math) and `created_at` (entry time).
- Frontend state colors (mint/amber/red via `.ok/.low/.neg`) are computed client-side in `app.js` `stateClass()`: negative → red, ≤20% of the window's allowance → amber.
- **Category autofill is a suggestion, not a rule.** `GET /api/merchants` returns `top_categories` (each merchant's most-used category, ties broken toward most recent). `categoryAutofiller()` in `app.js` writes the category field only when it is empty or still holds a value the filler itself put there, so anything typed by hand is never overwritten. It fires on an explicit dropdown pick and on blur/change when the typed text exactly matches an existing merchant — both are *selecting* a merchant, versus creating one, which never autofills.
- **Deleting history is a soft delete.** `POST /api/reset` (requires `confirm: true`) calls `db.reset_database()`, which snapshots the DB into `data/backups/budget-<stamp>.db` using SQLite's online backup API — not a file copy, so it is consistent mid-write and leaves no journal — then empties the live file in place and `VACUUM`s it. Emptied in place deliberately: the DB is a mounted volume, so replacing the inode would strand any open connection. The monthly budget is a setting rather than history, so it is read before the wipe and written back after.
- **`/api/widget` is a separate contract from `/api/summary`.** Both derive from `_summary_cents()`, so the window math has one home, but the widget payload is shaped for the phone: two windows, each with `remaining`/`allowance`/`spent`/`fraction`/`state`, plus an `as_of` stamp. It carries `state` because the widget can't see the stylesheet — `state_for()` in `main.py` is the server-side twin of `stateClass()` in `app.js` (and of the `unset` branch in `renderSummary()`). Change one and change the other. Keeping the shape separate means the web UI can gain fields without breaking a widget that's hard to update.
- **`/api/budget-history` returns period *results*, not a filtered aggregate.** It answers "how did each completed week and month end up" — allowance minus that period's whole spend — for the stats view's surplus/deficit chart. Four rules keep it honest: a period's number is always its own full spend, so it never shifts with the window you view it through (the range only picks *which* periods appear); merchant/category filters are deliberately absent, because a period is scored against the whole budget and narrowing to one category would make every period a surplus; only fully-elapsed periods are returned, so a three-day-old month can't post a near-total surplus; and the range start is clamped to the first transaction, since periods before tracking began would otherwise be phantom full surpluses. Every period is scored against the *current* `monthly_budget` — it is a single setting with no history, so changing it rescales the whole chart, which is why the UI labels it. `db.spent_cents_by_period()` does the grouping; its SQL week key (`date(txn_date, '-6 days', 'weekday 0')`) is the twin of `week_start()` in `main.py`.
- **The surplus/deficit chart puts both windows on one weekly axis.** `renderNetChart()` in `app.js` draws each week as a diverging bar (mint above zero, red below) and the month's result as a stepped line held flat across the weeks it spans, so the two series share a real dollar axis without a second scale. A week is drawn under the month holding its midpoint — a drawing rule only; the windows themselves stay independent. Its `<section>` sits *outside* `#statsCharts` on purpose: that block is hidden when the filtered transaction count is zero, and this chart ignores those filters.
- **New columns go in `LATER_COLUMNS`, not just `SCHEMA`.** `SCHEMA` is all `CREATE TABLE IF NOT EXISTS`, so an existing database never picks up a column added to it. `db.LATER_COLUMNS` lists `(table, column, definition)` triples that `init_db()` adds via `ALTER TABLE` when `PRAGMA table_info` shows them missing — that is how `transactions.comment` reached already-populated databases. Add to both: `SCHEMA` for fresh databases, `LATER_COLUMNS` for existing ones.
- **Transaction comments are optional free text.** `comment` is a nullable `TEXT` column, capped at `MAX_COMMENT_LEN` (280) in `main.py`. Unlike merchant/category it is not an identity, so only the ends are trimmed — internal whitespace and case survive — and blank collapses to `NULL`, so "no comment" has one representation. `PUT /api/transactions/{id}` replaces the whole transaction, so omitting `comment` clears it; the UI always sends the field. Entered on the dashboard form and the history inline edit; not yet shown in any list.
- **Static assets must revalidate.** There is no build step and so no content hashing: `app.js` keeps its name across rebuilds. `RevalidatingStaticFiles` in `main.py` and the `/` handler send `Cache-Control: no-cache` (ETags still yield 304s) because browsers were otherwise heuristically caching `app.js` and silently shadowing rebuilt frontends. The `?v=` on the asset URLs in `index.html` exists to bust copies cached before those headers; bump it if a stale asset ever survives a rebuild again.

Built since the original spec: the history page, the stats page, and the stats page's surplus/deficit-by-period chart. Still unbuilt: a smarter weekly allowance than `monthly/4`. The full design spec from the original build lives at `~/.claude/plans/delegated-honking-rain.md`.

## Gotchas

- Python 3.10+ syntax (`X | None`) is used throughout; the Mac's system python3 (3.9) cannot import these modules. Use `.venv` (3.13) or Docker (3.12).
- `data/` is the live SQLite database (gitignored, volume-mounted into the container). Deleting it wipes real user data.
- `data/backups/` holds the soft-delete snapshots — real user data, gitignored only because it sits under `data/`. Nothing prunes them and nothing overwrites them (a second reset within the same second gets a `-2` suffix). Restore by stopping the container, copying a backup over `data/budget.db`, and starting it again.
- **Chart.js: `this.chart.chartArea` is undefined on the first tick-callback pass** — ticks are generated before layout runs. A tick callback that reads it throws *inside the `Chart` constructor*, which has already registered the instance against the canvas, so `replaceChart`'s assignment never happens and every later render dies with "Canvas is already in use". Guard the read (`chartArea?.width ?? chart.width`); `replaceChart` also falls back to `Chart.getChart(canvas)` so one bad render can't brick a canvas for the session.
- Screenshotting charts over the DevTools protocol has three traps beyond the two above: `Page.captureScreenshot` with `captureBeyondViewport` resizes the canvas, and Chart.js re-renders *animated*, so the capture lands on frame zero with every mark flat at the baseline (set `Chart.defaults.animation = false` and `chart.update("none")` first); it also re-lays-out the page and discards `Emulation.setDeviceMetricsOverride`, so mobile shots must be viewport-only; and `Network.setCacheDisabled` silently does nothing unless `Network.enable` was sent on that connection first.
- Static files are baked into the Docker image — frontend changes need `docker compose up -d --build`, not just a restart.
