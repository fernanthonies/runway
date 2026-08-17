"""Budget tracker — light FastAPI server over SQLite.

Remaining budgets are computed per request from the transaction log and the
current date, so weekly (Sunday) and monthly (1st) resets need no scheduler.
"""

from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Budget Tracker")
db.init_db()

MAX_AMOUNT = 1_000_000
MAX_NAME_LEN = 64


def cents_to_dollars(cents: int) -> float:
    return round(cents / 100, 2)


def dollars_to_cents(dollars: float) -> int:
    return round(dollars * 100)


def week_start(today: date) -> date:
    """Most recent Sunday on or before today."""
    return today - timedelta(days=(today.weekday() + 1) % 7)


def month_bounds(today: date) -> tuple[date, date]:
    first = today.replace(day=1)
    next_first = (first + timedelta(days=32)).replace(day=1)
    return first, next_first


def build_summary() -> dict:
    today = date.today()
    ws = week_start(today)
    we = ws + timedelta(days=7)
    ms, me = month_bounds(today)

    budget_c = db.get_monthly_budget_cents()
    monthly_spent_c = db.spent_cents_between(ms.isoformat(), me.isoformat())
    weekly_spent_c = db.spent_cents_between(ws.isoformat(), we.isoformat())
    weekly_allowance_c = round(budget_c / 4)

    return {
        "today": today.isoformat(),
        "month_start": ms.isoformat(),
        "week_start": ws.isoformat(),
        "monthly_budget": cents_to_dollars(budget_c),
        "monthly_spent": cents_to_dollars(monthly_spent_c),
        "monthly_remaining": cents_to_dollars(budget_c - monthly_spent_c),
        "weekly_allowance": cents_to_dollars(weekly_allowance_c),
        "weekly_spent": cents_to_dollars(weekly_spent_c),
        "weekly_remaining": cents_to_dollars(weekly_allowance_c - weekly_spent_c),
    }


class TransactionIn(BaseModel):
    amount: float
    merchant: str
    category: str
    date: str | None = None


class SettingsIn(BaseModel):
    monthly_budget: float


class ResetIn(BaseModel):
    confirm: bool = False


def _clean_name(value: str, field: str) -> str:
    name = " ".join(value.split())
    if not name:
        raise HTTPException(400, f"{field} is required")
    if len(name) > MAX_NAME_LEN:
        raise HTTPException(400, f"{field} must be {MAX_NAME_LEN} characters or fewer")
    return name


def _parse_date(value: str, label: str = "Date") -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, f"{label} must be YYYY-MM-DD")


def _validate_txn(body: "TransactionIn") -> tuple[int, str, str, str]:
    """Validate a transaction payload; returns (amount_cents, merchant, category, txn_date_iso)."""
    if not (0 < body.amount < MAX_AMOUNT):
        raise HTTPException(400, "Amount must be greater than 0")
    merchant = _clean_name(body.merchant, "Merchant")
    category = _clean_name(body.category, "Category")
    txn_date = _parse_date(body.date) if body.date else date.today()
    return dollars_to_cents(body.amount), merchant, category, txn_date.isoformat()


def txn_to_json(txn: dict) -> dict:
    return {
        "id": txn["id"],
        "amount": cents_to_dollars(txn["amount_cents"]),
        "merchant": txn["merchant"],
        "category": txn["category"],
        "date": txn["txn_date"],
        "created_at": txn["created_at"],
    }


@app.get("/api/summary")
def get_summary():
    return build_summary()


@app.post("/api/transactions", status_code=201)
def create_transaction(body: TransactionIn):
    amount_cents, merchant, category, txn_date = _validate_txn(body)
    txn = db.add_transaction(
        amount_cents,
        merchant,
        category,
        txn_date,
        datetime.now().isoformat(timespec="seconds"),
    )
    return {"transaction": txn_to_json(txn), "summary": build_summary()}


@app.get("/api/transactions")
def list_transactions(
    limit: int = 5,
    offset: int = 0,
    start: str | None = None,
    end: str | None = None,
    merchant: str | None = None,
    category: str | None = None,
):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    start_iso = _parse_date(start, "Start date").isoformat() if start else None
    # `end` is inclusive from the client's perspective; the DB window is half-open.
    end_iso = (_parse_date(end, "End date") + timedelta(days=1)).isoformat() if end else None
    txns, total = db.list_transactions(start_iso, end_iso, merchant, category, limit, offset)
    return {"transactions": [txn_to_json(t) for t in txns], "total": total}


@app.get("/api/stats")
def get_stats(
    start: str | None = None,
    end: str | None = None,
    merchant: str | None = None,
    category: str | None = None,
):
    start_iso = _parse_date(start, "Start date").isoformat() if start else None
    # `end` is inclusive from the client's perspective; the DB window is half-open.
    end_iso = (_parse_date(end, "End date") + timedelta(days=1)).isoformat() if end else None
    stats = db.stats_between(start_iso, end_iso, merchant, category)

    totals = stats["totals"]
    return {
        "totals": {
            "spent": cents_to_dollars(totals["cents"]),
            "count": totals["count"],
            "average": cents_to_dollars(round(totals["cents"] / totals["count"]) if totals["count"] else 0),
        },
        "by_category": [
            {"name": r["name"], "spent": cents_to_dollars(r["cents"]), "count": r["count"]}
            for r in stats["by_category"]
        ],
        "by_merchant": [
            {"name": r["name"], "spent": cents_to_dollars(r["cents"]), "count": r["count"]}
            for r in stats["by_merchant"]
        ],
        "by_month": [
            {"month": r["month"], "category": r["category"], "spent": cents_to_dollars(r["cents"])}
            for r in stats["by_month"]
        ],
    }


@app.put("/api/transactions/{txn_id}")
def edit_transaction(txn_id: int, body: TransactionIn):
    amount_cents, merchant, category, txn_date = _validate_txn(body)
    txn = db.update_transaction(txn_id, amount_cents, merchant, category, txn_date)
    if txn is None:
        raise HTTPException(404, "Transaction not found")
    return {"transaction": txn_to_json(txn), "summary": build_summary()}


@app.delete("/api/transactions/{txn_id}")
def remove_transaction(txn_id: int):
    if not db.delete_transaction(txn_id):
        raise HTTPException(404, "Transaction not found")
    return {"summary": build_summary()}


@app.get("/api/merchants")
def get_merchants():
    return {
        "merchants": db.list_names("merchants"),
        "top_categories": db.merchant_top_categories(),
    }


@app.get("/api/categories")
def get_categories():
    return {"categories": db.list_names("categories")}


@app.get("/api/settings")
def get_settings():
    return {"monthly_budget": cents_to_dollars(db.get_monthly_budget_cents())}


@app.put("/api/settings")
def update_settings(body: SettingsIn):
    if not (0 <= body.monthly_budget < MAX_AMOUNT):
        raise HTTPException(400, "Monthly budget must be a non-negative amount")
    db.set_monthly_budget_cents(dollars_to_cents(body.monthly_budget))
    return {"monthly_budget": cents_to_dollars(db.get_monthly_budget_cents()), "summary": build_summary()}


@app.post("/api/reset")
def reset_data(body: ResetIn):
    """Soft-delete all history: back the database up, then start it empty.

    `confirm` must be true, so a stray POST can't wipe the log; the UI's
    are-you-sure step is what sets it.
    """
    if not body.confirm:
        raise HTTPException(400, "Deleting history must be confirmed")
    backup = db.reset_database(datetime.now().strftime("%Y%m%d-%H%M%S"))
    return {"backup": backup, "summary": build_summary()}


class RevalidatingStaticFiles(StaticFiles):
    """Static assets that must be revalidated on every load.

    There is no build step and so no content hashing: app.js keeps its name
    across rebuilds. Without an explicit Cache-Control, browsers heuristically
    cache it and a rebuilt frontend silently doesn't reach the page. `no-cache`
    still allows a 304 via the ETag, so revalidation stays cheap.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@app.get("/")
def index():
    return FileResponse(
        BASE_DIR / "static" / "index.html", headers={"Cache-Control": "no-cache"}
    )


app.mount("/static", RevalidatingStaticFiles(directory=BASE_DIR / "static"), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
