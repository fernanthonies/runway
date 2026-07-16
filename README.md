# ◆ Runway

A one-page personal budget tracker. One big number — what's left this month — with your weekly allowance underneath and a quick-entry form for logging spending as it happens.

![Runway screenshot](docs/screenshot.jpg)

## Features

- **Monthly + weekly remaining budgets**, computed live from your transaction log. The weekly allowance resets every Sunday, the monthly budget on the 1st — with no schedulers or stored balances, so history is never mutated and the numbers are always consistent.
- **Fast transaction entry**: amount, merchant, category, and an optional date for backdating (defaults to today). Merchant and category fields autocomplete from everything you've entered before — type to filter, click or arrow-key to select.
- **Color-coded numbers**: mint when healthy, amber when you're under 20% of the window's allowance, red when negative.
- **Recent transactions with one-click undo** for fixing fat-fingered entries.
- **Configurable monthly budget** via the gear icon; the weekly allowance is monthly ÷ 4.
- SQLite on a mounted volume — your data survives container rebuilds.

## Quick start

```bash
docker compose up -d --build
```

Open http://localhost:8100, click the gear, set your monthly budget, and start logging.

> The host port (default **8100**) and timezone are set in `docker-compose.yml`. Set `TZ` to your local timezone — it determines when the Sunday/1st-of-month resets happen.

## Running without Docker

Requires Python 3.10+ (3.12/3.13 recommended):

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --reload   # http://localhost:8000
```

The SQLite database lives at `./data/budget.db` (override with the `BUDGET_DB` env var).

## Stack

- **Backend**: FastAPI + stdlib `sqlite3`. Money is stored as integer cents.
- **Frontend**: vanilla HTML/CSS/JS, no build step.
- **API**: JSON under `/api/*` — `summary`, `transactions` (POST/GET/DELETE), `merchants`, `categories`, `settings`.

## Roadmap

- Transaction log page
- Stats page
- Smarter weekly allowance than monthly ÷ 4
