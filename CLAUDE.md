# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Runway" — a single-page personal budget tracker. FastAPI + stdlib sqlite3 backend, vanilla HTML/CSS/JS frontend (no build step, no npm). Single user, no auth. Docker is the primary way to run it.

## Commands

```bash
# Run (primary): http://localhost:8100 — host port is 8100 because 8000 is
# taken by another container (backlog-board) on this machine
docker compose up -d --build

# Local dev (system python3 is 3.9 — too old; venv uses python3.13)
.venv/bin/uvicorn main:app --reload          # serves on :8000
# If .venv is missing/broken: python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

There are no tests or linters configured. Verify changes by exercising the API with curl (see `GET /api/summary`) and loading the page in a browser.

## Architecture

Two Python files plus static assets:

- `db.py` — SQLite layer. Opens a new connection per call. DB path comes from the `BUDGET_DB` env var (set to `/data/budget.db` in Docker, defaults to `./data/budget.db` locally).
- `main.py` — FastAPI routes under `/api/*`, serves `static/index.html` at `/`. All budget math lives in `build_summary()`.
- `static/app.js` — all frontend logic; `static/style.css` — the dark "instrument panel" theme.

Core design decisions that everything depends on:

- **Resets are computed, never scheduled.** There is no cron/scheduler and no stored "remaining balance". Every request derives remaining budgets from the transaction log and today's date: monthly window = current calendar month; weekly window = most recent Sunday through Saturday. The two windows are independent (a week straddling the 1st draws from both months' views — intentional). Weekly allowance is `monthly_budget / 4`. Because of this, the container's `TZ` (set in docker-compose.yml) matters: it determines when "today" rolls over.
- **Money is integer cents in the DB and dollars (floats) at the API boundary.** Conversion happens only in `main.py` (`dollars_to_cents` / `cents_to_dollars`). Don't do arithmetic on dollar floats.
- **Merchants and categories are auto-upserted**, unique case-insensitively (`COLLATE NOCASE`), when a transaction is posted. They're never deleted, so they persist as autocomplete suggestions even after their transactions are removed.
- **Backdating**: transactions have both `txn_date` (user-settable, drives all budget math) and `created_at` (entry time).
- Frontend state colors (mint/amber/red via `.ok/.low/.neg`) are computed client-side in `app.js` `stateClass()`: negative → red, ≤20% of the window's allowance → amber.

Planned but not yet built (schema/API already accommodate them): a transaction-log page, a stats page, and a smarter weekly allowance than `monthly/4`. The full design spec from the original build lives at `~/.claude/plans/delegated-honking-rain.md`.

## Gotchas

- Python 3.10+ syntax (`X | None`) is used throughout; the Mac's system python3 (3.9) cannot import these modules. Use `.venv` (3.13) or Docker (3.12).
- `data/` is the live SQLite database (gitignored, volume-mounted into the container). Deleting it wipes real user data.
- Static files are baked into the Docker image — frontend changes need `docker compose up -d --build`, not just a restart.
