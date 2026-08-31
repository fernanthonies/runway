"""SQLite layer for the budget tracker.

Money is stored as integer cents. Merchant and category names are unique
case-insensitively and are upserted as transactions reference them.
"""

import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BUDGET_DB", BASE_DIR / "data" / "budget.db"))
BACKUP_DIR = DB_PATH.parent / "backups"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY,
    amount_cents INTEGER NOT NULL,
    merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    txn_date     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    comment      TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)


# Columns added after the first release. SCHEMA only runs CREATE TABLE IF NOT
# EXISTS, so an existing database never picks them up from it — they are added
# here instead. Each entry is (table, column, definition); adding one is safe to
# re-run because the column list is checked first.
LATER_COLUMNS = [("transactions", "comment", "TEXT")]


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    for table, column, definition in LATER_COLUMNS:
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def get_monthly_budget_cents() -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'monthly_budget_cents'"
        ).fetchone()
    return int(row["value"]) if row else 0


def set_monthly_budget_cents(cents: int) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('monthly_budget_cents', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(cents),),
        )


def _upsert_name(conn: sqlite3.Connection, table: str, name: str) -> int:
    assert table in ("merchants", "categories")
    row = conn.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(f"INSERT INTO {table} (name) VALUES (?)", (name,))
    return cur.lastrowid


def list_names(table: str) -> list[str]:
    assert table in ("merchants", "categories")
    with connect() as conn:
        rows = conn.execute(f"SELECT name FROM {table} ORDER BY name COLLATE NOCASE").fetchall()
    return [r["name"] for r in rows]


def merchant_top_categories() -> dict[str, str]:
    """Each merchant's most-used category, keyed by merchant name.

    Powers category autofill when an existing merchant is picked. Ties break
    toward the most recently used category; merchants with no transactions
    (names linger after their transactions are deleted) are absent.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT m.name AS merchant, c.name AS category, COUNT(*) AS n, "
            "MAX(t.txn_date) AS last_used "
            "FROM transactions t "
            "JOIN merchants m ON m.id = t.merchant_id "
            "JOIN categories c ON c.id = t.category_id "
            "GROUP BY t.merchant_id, t.category_id "
            "ORDER BY t.merchant_id, n DESC, last_used DESC"
        ).fetchall()

    top: dict[str, str] = {}
    for r in rows:
        top.setdefault(r["merchant"], r["category"])  # rows are pre-ranked per merchant
    return top


def add_transaction(
    amount_cents: int,
    merchant: str,
    category: str,
    txn_date: str,
    created_at: str,
    comment: str | None = None,
) -> dict:
    with connect() as conn:
        merchant_id = _upsert_name(conn, "merchants", merchant)
        category_id = _upsert_name(conn, "categories", category)
        cur = conn.execute(
            "INSERT INTO transactions "
            "(amount_cents, merchant_id, category_id, txn_date, created_at, comment) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (amount_cents, merchant_id, category_id, txn_date, created_at, comment),
        )
        txn_id = cur.lastrowid
    return get_transaction(txn_id)


def get_transaction(txn_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT t.id, t.amount_cents, t.txn_date, t.created_at, t.comment, "
            "m.name AS merchant, c.name AS category "
            "FROM transactions t "
            "JOIN merchants m ON m.id = t.merchant_id "
            "JOIN categories c ON c.id = t.category_id "
            "WHERE t.id = ?",
            (txn_id,),
        ).fetchone()
    return dict(row) if row else None


def _txn_filter(
    start: str | None,
    end: str | None,
    merchant: str | None,
    category: str | None,
) -> tuple[str, list]:
    """Shared FROM/WHERE clause for filtered transaction queries.

    start/end are ISO dates forming a half-open window [start, end).
    Merchant/category match exactly, case-insensitively.
    """
    where = []
    params: list = []
    if start:
        where.append("t.txn_date >= ?")
        params.append(start)
    if end:
        where.append("t.txn_date < ?")
        params.append(end)
    if merchant:
        where.append("m.name = ? COLLATE NOCASE")
        params.append(merchant)
    if category:
        where.append("c.name = ? COLLATE NOCASE")
        params.append(category)

    base = (
        "FROM transactions t "
        "JOIN merchants m ON m.id = t.merchant_id "
        "JOIN categories c ON c.id = t.category_id "
    )
    if where:
        base += "WHERE " + " AND ".join(where) + " "
    return base, params


def list_transactions(
    start: str | None = None,
    end: str | None = None,
    merchant: str | None = None,
    category: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Filtered page of transactions plus the total matching count."""
    base, params = _txn_filter(start, end, merchant, category)

    with connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n {base}", params).fetchone()["n"]
        rows = conn.execute(
            "SELECT t.id, t.amount_cents, t.txn_date, t.created_at, t.comment, "
            "m.name AS merchant, c.name AS category "
            f"{base}ORDER BY t.txn_date DESC, t.id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    return [dict(r) for r in rows], total


def update_transaction(
    txn_id: int,
    amount_cents: int,
    merchant: str,
    category: str,
    txn_date: str,
    comment: str | None = None,
) -> dict | None:
    with connect() as conn:
        # Check existence first so a 404 doesn't leave upserted names behind.
        if not conn.execute("SELECT 1 FROM transactions WHERE id = ?", (txn_id,)).fetchone():
            return None
        merchant_id = _upsert_name(conn, "merchants", merchant)
        category_id = _upsert_name(conn, "categories", category)
        conn.execute(
            "UPDATE transactions SET amount_cents = ?, merchant_id = ?, "
            "category_id = ?, txn_date = ?, comment = ? WHERE id = ?",
            (amount_cents, merchant_id, category_id, txn_date, comment, txn_id),
        )
    return get_transaction(txn_id)


def delete_transaction(txn_id: int) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    return cur.rowcount > 0


def stats_between(
    start: str | None = None,
    end: str | None = None,
    merchant: str | None = None,
    category: str | None = None,
) -> dict:
    """Aggregates for the stats page, all under the same filter semantics
    as list_transactions. Sums are integer cents.
    """
    base, params = _txn_filter(start, end, merchant, category)

    with connect() as conn:
        totals = conn.execute(
            f"SELECT COALESCE(SUM(t.amount_cents), 0) AS cents, COUNT(*) AS count {base}",
            params,
        ).fetchone()
        by_category = conn.execute(
            "SELECT c.name AS name, SUM(t.amount_cents) AS cents, COUNT(*) AS count "
            f"{base}GROUP BY c.id ORDER BY cents DESC",
            params,
        ).fetchall()
        by_merchant = conn.execute(
            "SELECT m.name AS name, SUM(t.amount_cents) AS cents, COUNT(*) AS count "
            f"{base}GROUP BY m.id ORDER BY cents DESC",
            params,
        ).fetchall()
        by_month = conn.execute(
            "SELECT substr(t.txn_date, 1, 7) AS month, c.name AS category, "
            "SUM(t.amount_cents) AS cents "
            f"{base}GROUP BY month, c.id ORDER BY month",
            params,
        ).fetchall()

    return {
        "totals": dict(totals),
        "by_category": [dict(r) for r in by_category],
        "by_merchant": [dict(r) for r in by_merchant],
        "by_month": [dict(r) for r in by_month],
    }


def reset_database(stamp: str) -> str:
    """Back the database up to a timestamped file, then empty the live one.

    The "soft" in soft delete is the backup: nothing is lost, it just stops
    counting. Returns the backup's filename.

    Two deliberate mechanics:
    - The snapshot uses SQLite's online backup API instead of copying the file,
      so it is consistent even if a write is in flight and leaves no journal.
    - The live database is emptied in place rather than unlinked and recreated.
      It's a volume-mounted file under Docker, and replacing the inode would
      strand any connection still holding the old one.

    The monthly budget is a setting rather than history, so it is carried over.
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    # Never overwrite an existing backup — two resets in the same second still
    # each keep their own copy.
    backup_path = BACKUP_DIR / f"budget-{stamp}.db"
    attempt = 1
    while backup_path.exists():
        attempt += 1
        backup_path = BACKUP_DIR / f"budget-{stamp}-{attempt}.db"

    src = connect()
    try:
        dst = sqlite3.connect(backup_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()

    budget_cents = get_monthly_budget_cents()
    with connect() as conn:
        # transactions first: they reference merchants/categories.
        for table in ("transactions", "merchants", "categories", "settings"):
            conn.execute(f"DELETE FROM {table}")
    with connect() as conn:
        conn.execute("VACUUM")  # shrink the file and drop the freed pages
    set_monthly_budget_cents(budget_cents)

    return backup_path.name


def spent_cents_between(start_iso: str, end_iso: str) -> int:
    """Sum of transactions with start <= txn_date < end."""
    with connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions "
            "WHERE txn_date >= ? AND txn_date < ?",
            (start_iso, end_iso),
        ).fetchone()
    return row["total"]


# Most recent Sunday on or before txn_date — the SQL twin of `week_start()` in
# main.py. `weekday 0` snaps forward to the next Sunday, so backing up six days
# first lands on the Sunday that started the week.
_PERIOD_KEY = {
    "week": "date(txn_date, '-6 days', 'weekday 0')",
    "month": "substr(txn_date, 1, 7)",
}


def spent_cents_by_period(period: str) -> dict[str, int]:
    """Total spend per calendar period, keyed by period start.

    Weeks key on an ISO date (their Sunday), months on `YYYY-MM`. Every
    transaction is counted, unfiltered by merchant or category: a period's
    result is measured against the whole budget, so narrowing to one category
    would make every period look like a surplus. Periods with no transactions
    are simply absent — the caller enumerates the calendar and fills the gaps.
    """
    key = _PERIOD_KEY[period]
    with connect() as conn:
        rows = conn.execute(
            f"SELECT {key} AS period, SUM(amount_cents) AS cents "
            "FROM transactions GROUP BY period"
        ).fetchall()
    return {r["period"]: r["cents"] for r in rows}


def first_txn_date() -> str | None:
    """Earliest txn_date in the log, or None when there are no transactions."""
    with connect() as conn:
        row = conn.execute("SELECT MIN(txn_date) AS d FROM transactions").fetchone()
    return row["d"]
