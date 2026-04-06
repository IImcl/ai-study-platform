import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db import db, get_database_backend, get_database_url, init_db

TABLE_COLUMNS = {
    "sessions": ["session_id", "name", "created_at", "updated_at"],
    "sources": ["session_id", "source_id", "name", "text", "created_at"],
    "pages": ["session_id", "citation", "text", "emb_json", "created_at"],
    "indexing_status": [
        "session_id",
        "source_id",
        "status",
        "detail",
        "pages_total",
        "pages_done",
        "updated_at",
    ],
}


def _available_columns(sqlite_conn, table: str) -> set[str]:
    rows = sqlite_conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def main():
    parser = argparse.ArgumentParser(
        description="Copy the existing local SQLite data into the PostgreSQL DATABASE_URL."
    )
    parser.add_argument(
        "--sqlite-path",
        default=str(ROOT / "app.db"),
        help="Path to the source SQLite database file.",
    )
    args = parser.parse_args()

    if get_database_backend() != "postgresql":
        raise SystemExit(
            "DATABASE_URL must point to PostgreSQL before running this migration script."
        )

    sqlite_path = Path(args.sqlite_path).resolve()
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite database not found: {sqlite_path}")

    init_db()

    sqlite_conn = sqlite3.connect(str(sqlite_path))
    sqlite_conn.row_factory = sqlite3.Row

    copied_counts = {}
    try:
        with db() as pg_conn:
            for table, columns in TABLE_COLUMNS.items():
                available = _available_columns(sqlite_conn, table)
                select_columns = [col for col in columns if col in available]
                rows = sqlite_conn.execute(
                    f"SELECT {', '.join(select_columns)} FROM {table}"
                ).fetchall()

                placeholders = ",".join(["?"] * len(columns))
                sql = (
                    f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) "
                    f"VALUES ({placeholders})"
                )

                for row in rows:
                    pg_conn.execute(
                        sql,
                        tuple(row[col] if col in available else 0 for col in columns),
                    )

                copied_counts[table] = len(rows)
    finally:
        sqlite_conn.close()

    print(f"Target PostgreSQL database: {get_database_url()}")
    for table, count in copied_counts.items():
        print(f"{table}: {count} rows copied")


if __name__ == "__main__":
    main()
