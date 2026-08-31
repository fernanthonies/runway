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
MAX_COMMENT_LEN = 280


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


def _summary_cents() -> dict:
    """The window math, in cents. Sole source for /api/summary and /api/widget."""
    today = date.today()
    ws = week_start(today)
    we = ws + timedelta(days=7)
    ms, me = month_bounds(today)

    budget_c = db.get_monthly_budget_cents()
    weekly_allowance_c = round(budget_c / 4)
    monthly_spent_c = db.spent_cents_between(ms.isoformat(), me.isoformat())
    weekly_spent_c = db.spent_cents_between(ws.isoformat(), we.isoformat())

    return {
        "today": today,
        "month_start": ms,
        "week_start": ws,
        "monthly_budget_c": budget_c,
        "monthly_spent_c": monthly_spent_c,
        "monthly_remaining_c": budget_c - monthly_spent_c,
        "weekly_allowance_c": weekly_allowance_c,
        "weekly_spent_c": weekly_spent_c,
        "weekly_remaining_c": weekly_allowance_c - weekly_spent_c,
    }


def build_summary() -> dict:
    s = _summary_cents()
    return {
        "today": s["today"].isoformat(),
        "month_start": s["month_start"].isoformat(),
        "week_start": s["week_start"].isoformat(),
        "monthly_budget": cents_to_dollars(s["monthly_budget_c"]),
        "monthly_spent": cents_to_dollars(s["monthly_spent_c"]),
        "monthly_remaining": cents_to_dollars(s["monthly_remaining_c"]),
        "weekly_allowance": cents_to_dollars(s["weekly_allowance_c"]),
        "weekly_spent": cents_to_dollars(s["weekly_spent_c"]),
        "weekly_remaining": cents_to_dollars(s["weekly_remaining_c"]),
    }


def state_for(remaining_c: int, allowance_c: int) -> str:
    """Server-side twin of `stateClass()` in app.js — keep the two in step.

    The widget can't see the stylesheet, so the colour decision ships with the
    numbers rather than being reimplemented on the phone.
    """
    if allowance_c <= 0:
        return "unset"
    if remaining_c < 0:
        return "neg"
    if remaining_c <= allowance_c * 0.2:
        return "low"
    return "ok"


def _window(remaining_c: int, allowance_c: int, spent_c: int) -> dict:
    frac = max(0.0, min(1.0, remaining_c / allowance_c)) if allowance_c > 0 else 0.0
    return {
        "remaining": cents_to_dollars(remaining_c),
        "allowance": cents_to_dollars(allowance_c),
        "spent": cents_to_dollars(spent_c),
        "fraction": round(frac, 4),
        "state": state_for(remaining_c, allowance_c),
    }


def build_widget() -> dict:
    """Minimal payload for the iOS widget: two numbers, each with its state.

    Deliberately a separate shape from /api/summary so the widget's contract
    doesn't move whenever the web UI needs another field.
    """
    s = _summary_cents()
    return {
        "as_of": datetime.now().isoformat(timespec="seconds"),
        "today": s["today"].isoformat(),
        "week": _window(s["weekly_remaining_c"], s["weekly_allowance_c"], s["weekly_spent_c"]),
        "month": _window(s["monthly_remaining_c"], s["monthly_budget_c"], s["monthly_spent_c"]),
    }


# A guard on the period walk, not a real limit: ~7 years of weeks.
MAX_PERIODS = 400


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _next_month(d: date) -> date:
    return (d.replace(day=1) + timedelta(days=32)).replace(day=1)


def _periods(kind: str, range_start: date, range_end: date, today: date):
    """Walk complete periods of `kind` that overlap [range_start, range_end].

    Yields (start, end_exclusive). A period is emitted only once it has fully
    elapsed, so the in-progress week and month are skipped — a month that is
    three days old would otherwise post a near-total surplus and read as the
    best month on record.
    """
    if kind == "week":
        start, step = week_start(range_start), lambda d: d + timedelta(days=7)
    else:
        start, step = _month_start(range_start), _next_month

    for _ in range(MAX_PERIODS):
        if start > range_end:
            return
        end = step(start)
        if end <= today:
            yield start, end
        start = end


def build_budget_history(start: date | None, end: date | None) -> dict:
    """Per-period surplus/deficit for the stats view's runway chart.

    Every period is scored on its own full spend against its own allowance, so
    a period's number never depends on the window you view it through — the
    range only chooses which periods are shown. For the same reason merchant
    and category filters are deliberately absent: a period's result is measured
    against the whole budget, and narrowing to one category would make every
    period look like a surplus.

    Both windows are scored against the *current* monthly budget. It is a
    single setting with no history, so there is no record of what it was in
    March; changing it rescales the whole chart, which is why the UI says so.
    """
    today = date.today()
    budget_c = db.get_monthly_budget_cents()
    weekly_allowance_c = round(budget_c / 4)
    result = {
        "monthly_budget": cents_to_dollars(budget_c),
        "weekly_allowance": cents_to_dollars(weekly_allowance_c),
        "weeks": [],
        "months": [],
    }

    first = db.first_txn_date()
    if first is None:
        return result
    # Clamp to the first transaction: periods before tracking began had no
    # budget to under-spend, and would otherwise post a phantom full surplus
    # whenever a preset range reaches back further than the log does.
    first_date = date.fromisoformat(first)
    range_start = max(start, first_date) if start else first_date
    range_end = end or today
    if range_end < range_start:
        return result

    def row(p_start: date, p_end: date, spent_c: int, allowance_c: int) -> dict:
        return {
            "start": p_start.isoformat(),
            # inclusive end, so the client can label a week "AUG 2 – AUG 8"
            "end": (p_end - timedelta(days=1)).isoformat(),
            "allowance": cents_to_dollars(allowance_c),
            "spent": cents_to_dollars(spent_c),
            "net": cents_to_dollars(allowance_c - spent_c),
        }

    by_week = db.spent_cents_by_period("week")
    by_month = db.spent_cents_by_period("month")
    result["weeks"] = [
        row(s, e, by_week.get(s.isoformat(), 0), weekly_allowance_c)
        for s, e in _periods("week", range_start, range_end, today)
    ]
    result["months"] = [
        row(s, e, by_month.get(s.isoformat()[:7], 0), budget_c)
        for s, e in _periods("month", range_start, range_end, today)
    ]
    return result


class TransactionIn(BaseModel):
    amount: float
    merchant: str
    category: str
    date: str | None = None
    comment: str | None = None


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


def _clean_comment(value: str | None) -> str | None:
    """Optional free text. Blank and absent are the same thing: no comment.

    Unlike merchant/category this is not an identity, so internal whitespace and
    case are left exactly as typed — only the ends are trimmed.
    """
    if value is None:
        return None
    comment = value.strip()
    if not comment:
        return None
    if len(comment) > MAX_COMMENT_LEN:
        raise HTTPException(400, f"Comment must be {MAX_COMMENT_LEN} characters or fewer")
    return comment


def _validate_txn(body: "TransactionIn") -> tuple[int, str, str, str, str | None]:
    """Validate a transaction payload; returns (amount_cents, merchant, category, txn_date_iso, comment)."""
    if not (0 < body.amount < MAX_AMOUNT):
        raise HTTPException(400, "Amount must be greater than 0")
    merchant = _clean_name(body.merchant, "Merchant")
    category = _clean_name(body.category, "Category")
    txn_date = _parse_date(body.date) if body.date else date.today()
    comment = _clean_comment(body.comment)
    return dollars_to_cents(body.amount), merchant, category, txn_date.isoformat(), comment


def txn_to_json(txn: dict) -> dict:
    return {
        "id": txn["id"],
        "amount": cents_to_dollars(txn["amount_cents"]),
        "merchant": txn["merchant"],
        "category": txn["category"],
        "date": txn["txn_date"],
        "created_at": txn["created_at"],
        "comment": txn["comment"],
    }


@app.get("/api/summary")
def get_summary():
    return build_summary()


@app.get("/api/widget")
def get_widget():
    return build_widget()


@app.post("/api/transactions", status_code=201)
def create_transaction(body: TransactionIn):
    amount_cents, merchant, category, txn_date, comment = _validate_txn(body)
    txn = db.add_transaction(
        amount_cents,
        merchant,
        category,
        txn_date,
        datetime.now().isoformat(timespec="seconds"),
        comment,
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


@app.get("/api/budget-history")
def get_budget_history(start: str | None = None, end: str | None = None):
    """Surplus/deficit per completed week and month.

    Unlike /api/transactions and /api/stats, `end` stays an inclusive calendar
    bound rather than becoming a half-open transaction window: it selects which
    periods to show, not which transactions to count.
    """
    return build_budget_history(
        _parse_date(start, "Start date") if start else None,
        _parse_date(end, "End date") if end else None,
    )


@app.put("/api/transactions/{txn_id}")
def edit_transaction(txn_id: int, body: TransactionIn):
    amount_cents, merchant, category, txn_date, comment = _validate_txn(body)
    txn = db.update_transaction(txn_id, amount_cents, merchant, category, txn_date, comment)
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
