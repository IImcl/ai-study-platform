import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent

PRIMARY_KEYS = {
    "sources": ("session_id", "source_id"),
    "pages": ("session_id", "citation"),
    "sessions": ("session_id",),
    "indexing_status": ("session_id", "source_id"),
}

SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS sources (
      session_id TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      name       TEXT,
      text       TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (session_id, source_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pages (
      session_id TEXT NOT NULL,
      citation   TEXT NOT NULL,
      text       TEXT NOT NULL,
      emb_json   TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (session_id, citation)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      name TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS indexing_status (
      session_id TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      status     TEXT NOT NULL,
      detail     TEXT,
      pages_total BIGINT NOT NULL DEFAULT 0,
      pages_done BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (session_id, source_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_pages_session ON pages(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_sources_session ON sources(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_indexing_session ON indexing_status(session_id)",
]

INSERT_OR_PATTERN = re.compile(
    r"^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)\s*$",
    re.IGNORECASE | re.DOTALL,
)


class NoOpCursor:
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class DBConnection:
    def __init__(self, conn, backend: str):
        self._conn = conn
        self.backend = backend

    def execute(self, query: str, params=None):
        params = () if params is None else params

        if self.backend == "postgresql":
            normalized = " ".join(query.strip().split()).upper()
            if normalized == "BEGIN IMMEDIATE":
                return NoOpCursor()
            query = _adapt_postgres_query(query)

        return self._conn.execute(query, params)


def get_database_url() -> str:
    raw = (os.getenv("DATABASE_URL") or "").strip()
    if raw:
        if raw.startswith("postgres://"):
            return "postgresql://" + raw[len("postgres://") :]
        return raw

    db_path = (os.getenv("DB_PATH") or "app.db").strip()
    path = Path(db_path)
    if not path.is_absolute():
        path = BASE_DIR / path
    return f"sqlite:///{path.resolve().as_posix()}"


def get_database_backend() -> str:
    scheme = urlparse(get_database_url()).scheme.lower()
    if scheme in {"postgres", "postgresql"}:
        return "postgresql"
    if scheme in {"sqlite", "sqlite3"}:
        return "sqlite"
    raise RuntimeError(f"Unsupported DATABASE_URL scheme: {scheme}")


def _connect_sqlite():
    parsed = urlparse(get_database_url())
    raw_path = unquote(f"{parsed.netloc}{parsed.path}")
    if raw_path.startswith("/") and re.match(r"^/[A-Za-z]:", raw_path):
        raw_path = raw_path[1:]

    path = Path(raw_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_postgres():
    try:
        from psycopg import connect
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError(
            "PostgreSQL support requires psycopg. Install backend requirements before starting the app."
        ) from exc

    return connect(get_database_url(), row_factory=dict_row)


def _adapt_postgres_query(query: str) -> str:
    translated = _translate_insert_or(query)
    return _replace_qmark_placeholders(translated)


def _translate_insert_or(query: str) -> str:
    match = INSERT_OR_PATTERN.match(query.strip())
    if not match:
        return query

    mode, table, columns_blob, values_blob = match.groups()
    conflict_cols = PRIMARY_KEYS.get(table)
    if not conflict_cols:
        raise RuntimeError(f"Missing conflict key mapping for table: {table}")

    columns = [col.strip() for col in columns_blob.split(",") if col.strip()]
    head = (
        f"INSERT INTO {table} ({', '.join(columns)}) "
        f"VALUES ({values_blob}) "
        f"ON CONFLICT ({', '.join(conflict_cols)}) "
    )

    if mode.upper() == "IGNORE":
        return head + "DO NOTHING"

    update_cols = [col for col in columns if col not in conflict_cols]
    if not update_cols:
        return head + "DO NOTHING"

    assignments = ", ".join(f"{col}=EXCLUDED.{col}" for col in update_cols)
    return head + f"DO UPDATE SET {assignments}"


def _replace_qmark_placeholders(query: str) -> str:
    out = []
    in_single = False
    in_double = False
    i = 0

    while i < len(query):
        ch = query[i]

        if ch == "'" and not in_double:
            if in_single and i + 1 < len(query) and query[i + 1] == "'":
                out.append("''")
                i += 2
                continue
            in_single = not in_single
            out.append(ch)
            i += 1
            continue

        if ch == '"' and not in_single:
            in_double = not in_double
            out.append(ch)
            i += 1
            continue

        if ch == "?" and not in_single and not in_double:
            out.append("%s")
        else:
            out.append(ch)

        i += 1

    return "".join(out)


@contextmanager
def db():
    backend = get_database_backend()
    conn = _connect_postgres() if backend == "postgresql" else _connect_sqlite()
    wrapper = DBConnection(conn, backend)

    try:
        yield wrapper
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    backend = get_database_backend()

    with db() as conn:
        if backend == "sqlite":
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")

        for statement in SCHEMA_STATEMENTS:
            conn.execute(statement)

        _migrate_indexing_status(conn, backend)


def _migrate_indexing_status(conn: DBConnection, backend: str):
    if backend == "postgresql":
        conn.execute(
            "ALTER TABLE indexing_status ADD COLUMN IF NOT EXISTS pages_total BIGINT NOT NULL DEFAULT 0"
        )
        conn.execute(
            "ALTER TABLE indexing_status ADD COLUMN IF NOT EXISTS pages_done BIGINT NOT NULL DEFAULT 0"
        )
        return

    rows = conn.execute("PRAGMA table_info(indexing_status)").fetchall()
    cols = {row["name"] for row in rows}

    if "pages_total" not in cols:
        conn.execute(
            "ALTER TABLE indexing_status ADD COLUMN pages_total BIGINT NOT NULL DEFAULT 0"
        )
    if "pages_done" not in cols:
        conn.execute(
            "ALTER TABLE indexing_status ADD COLUMN pages_done BIGINT NOT NULL DEFAULT 0"
        )
