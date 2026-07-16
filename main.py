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


def _clean_name(value: str, field: str) -> str:
    name = " ".join(value.split())
    if not name:
        raise HTTPException(400, f"{field} is required")
    if len(name) > MAX_NAME_LEN:
        raise HTTPException(400, f"{field} must be {MAX_NAME_LEN} characters or fewer")
    return name


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
    if not (0 < body.amount < MAX_AMOUNT):
        raise HTTPException(400, "Amount must be greater than 0")
    merchant = _clean_name(body.merchant, "Merchant")
    category = _clean_name(body.category, "Category")

    if body.date:
        try:
            txn_date = date.fromisoformat(body.date)
        except ValueError:
            raise HTTPException(400, "Date must be YYYY-MM-DD")
    else:
        txn_date = date.today()

    txn = db.add_transaction(
        dollars_to_cents(body.amount),
        merchant,
        category,
        txn_date.isoformat(),
        datetime.now().isoformat(timespec="seconds"),
    )
    return {"transaction": txn_to_json(txn), "summary": build_summary()}


@app.get("/api/transactions")
def list_transactions(limit: int = 5):
    limit = max(1, min(limit, 100))
    return {"transactions": [txn_to_json(t) for t in db.recent_transactions(limit)]}


@app.delete("/api/transactions/{txn_id}")
def remove_transaction(txn_id: int):
    if not db.delete_transaction(txn_id):
        raise HTTPException(404, "Transaction not found")
    return {"summary": build_summary()}


@app.get("/api/merchants")
def get_merchants():
    return {"merchants": db.list_names("merchants")}


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


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
