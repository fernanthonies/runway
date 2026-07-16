"""SQLite layer for the budget tracker.

Money is stored as integer cents. Merchant and category names are unique
case-insensitively and are upserted as transactions reference them.
"""

import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BUDGET_DB", BASE_DIR / "data" / "budget.db"))

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
    created_at   TEXT NOT NULL
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


def add_transaction(
    amount_cents: int, merchant: str, category: str, txn_date: str, created_at: str
) -> dict:
    with connect() as conn:
        merchant_id = _upsert_name(conn, "merchants", merchant)
        category_id = _upsert_name(conn, "categories", category)
        cur = conn.execute(
            "INSERT INTO transactions (amount_cents, merchant_id, category_id, txn_date, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (amount_cents, merchant_id, category_id, txn_date, created_at),
        )
        txn_id = cur.lastrowid
    return get_transaction(txn_id)


def get_transaction(txn_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT t.id, t.amount_cents, t.txn_date, t.created_at, "
            "m.name AS merchant, c.name AS category "
            "FROM transactions t "
            "JOIN merchants m ON m.id = t.merchant_id "
            "JOIN categories c ON c.id = t.category_id "
            "WHERE t.id = ?",
            (txn_id,),
        ).fetchone()
    return dict(row) if row else None


def recent_transactions(limit: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT t.id, t.amount_cents, t.txn_date, t.created_at, "
            "m.name AS merchant, c.name AS category "
            "FROM transactions t "
            "JOIN merchants m ON m.id = t.merchant_id "
            "JOIN categories c ON c.id = t.category_id "
            "ORDER BY t.txn_date DESC, t.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_transaction(txn_id: int) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    return cur.rowcount > 0


def spent_cents_between(start_iso: str, end_iso: str) -> int:
    """Sum of transactions with start <= txn_date < end."""
    with connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions "
            "WHERE txn_date >= ? AND txn_date < ?",
            (start_iso, end_iso),
        ).fetchone()
    return row["total"]
