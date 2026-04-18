# backend/app.py

import json
import logging
import math
import os
import random
import re
import time
from collections import defaultdict, deque
from functools import wraps
from logging.handlers import RotatingFileHandler
from threading import Thread
from dotenv import load_dotenv

from flask import Flask, request, jsonify
from flask_cors import CORS

from openai import OpenAI
from openai import (
    APIConnectionError,
    AuthenticationError,
    BadRequestError,
    RateLimitError,
    APIStatusError,
)

from prompts import PRESETS
from db import db, init_db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(__name__)
# Upload hard limit (bytes).
app.config["MAX_CONTENT_LENGTH"] = int(
    os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024))
)

MAX_REPAIR_TRIES = 1


def _normalize_origin(origin: str) -> str:
    return origin.strip().rstrip("/")


def _origin_to_cors_value(origin: str):
    normalized = _normalize_origin(origin)
    if not normalized or normalized == "*":
        return normalized
    if "*" not in normalized:
        return normalized

    escaped = re.escape(normalized).replace(r"\*", r".*")
    return rf"^{escaped}$"


def _get_allowed_origins():
    configured = {
        _origin_to_cors_value(origin)
        for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
        if _origin_to_cors_value(origin)
    }
    if "*" in configured:
        return "*"

    dev_defaults = {"http://localhost:8080", "http://127.0.0.1:8080"}
    return sorted(dev_defaults | configured)

# Keep local development origins and merge in deployment origins from ALLOWED_ORIGINS.
allowed_origins = _get_allowed_origins()

CORS(
    app,
    resources={r"/*": {"origins": allowed_origins}},
    allow_headers=["Content-Type", "X-Session-Id"],
    methods=["GET", "POST", "DELETE", "OPTIONS"],
)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "30"))
MAX_PAGE_CHARS = int(os.getenv("MAX_PAGE_CHARS", "12000"))
MAX_SOURCE_CHARS = int(os.getenv("MAX_SOURCE_CHARS", "250000"))
MAX_SOURCES_CHARS_PER_REQUEST = int(os.getenv("MAX_SOURCES_CHARS_PER_REQUEST", "300000"))
MAX_SESSION_NAME_CHARS = int(os.getenv("MAX_SESSION_NAME_CHARS", "120"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
GENERATION_MODEL = os.getenv("GENERATION_MODEL", "gpt-4.1-mini")

# GPT-4.1 family is non-reasoning, so don't send reasoning args to it.
GENERATION_KW = (
    {}
    if GENERATION_MODEL.startswith("gpt-4.1")
    else {"reasoning": {"effort": "medium"}}
)
TOP_K_PAGES = int(os.getenv("TOP_K_PAGES", "6"))
INDEX_BATCH_SIZE = int(os.getenv("INDEX_BATCH_SIZE", "24"))
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
SOURCE_ID_RE = re.compile(r"^S\d+$")

logs_dir = os.path.join(BASE_DIR, "logs")
os.makedirs(logs_dir, exist_ok=True)
handler = RotatingFileHandler(
    os.path.join(logs_dir, "app.log"),
    maxBytes=2_000_000,
    backupCount=3,
    encoding="utf-8",
)
handler.setLevel(logging.INFO)
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
app.logger.setLevel(logging.INFO)
app.logger.addHandler(handler)
init_db()


def is_valid_session_id(sid: str) -> bool:
    return bool(SESSION_RE.match(sid or "")) and sid != "local"


def get_session_id_from_request(req, data=None):
    sid = req.headers.get("X-Session-Id")
    if not sid and isinstance(data, dict):
        sid = data.get("session_id")
    sid = (sid or "").strip()
    return sid if is_valid_session_id(sid) else None


def ensure_session(sid: str):
    now = int(time.time())
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions(session_id, name, created_at, updated_at) VALUES (?,?,?,?)",
            (sid, sid, now, now),
        )
        conn.execute("UPDATE sessions SET updated_at=? WHERE session_id=?", (now, sid))


def get_session_id():
    sid = (request.headers.get("X-Session-Id") or "").strip()
    if not is_valid_session_id(sid):
        return None
    ensure_session(sid)
    return sid


def _normalize_session_name(value) -> str:
    collapsed = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(collapsed) <= MAX_SESSION_NAME_CHARS:
        return collapsed
    return collapsed[:MAX_SESSION_NAME_CHARS].rstrip()


def _session_title_is_default(session_id: str, name: str) -> bool:
    normalized = _normalize_session_name(name)
    return not normalized or normalized == session_id


def _set_session_name(session_id: str, name: str) -> str:
    normalized = _normalize_session_name(name)
    now = int(time.time())

    ensure_session(session_id)
    with db() as conn:
        conn.execute(
            "UPDATE sessions SET name=?, updated_at=? WHERE session_id=?",
            (normalized, now, session_id),
        )

    return normalized


def _maybe_auto_title_session_from_filename(session_id: str, filename: str) -> str:
    title = _normalize_session_name(os.path.splitext(os.path.basename(filename or ""))[0])
    if not title:
        return ""

    with db() as conn:
        row = conn.execute(
            "SELECT name FROM sessions WHERE session_id=?",
            (session_id,),
        ).fetchone()
        count_row = conn.execute(
            "SELECT COUNT(*) AS total FROM sources WHERE session_id=?",
            (session_id,),
        ).fetchone()

    current_name = row["name"] if row else ""
    total_sources = int((count_row["total"] if count_row else 0) or 0)
    if total_sources != 1 or not _session_title_is_default(session_id, current_name):
        return ""

    return _set_session_name(session_id, title)


RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "30"))
_HITS = defaultdict(deque)


def _client_key():
    return request.remote_addr or "unknown"


def rate_limit(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        now = time.time()
        q = _HITS[_client_key()]
        while q and (now - q[0]) > 60:
            q.popleft()
        if len(q) >= RATE_LIMIT_PER_MIN:
            return jsonify({"error": "LOCAL_RATE_LIMIT", "retry_after_sec": 60}), 429
        q.append(now)
        return fn(*args, **kwargs)

    return wrapper


def source_exists(session_id: str, source_id: str) -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT 1 FROM sources WHERE session_id=? AND source_id=?",
            (session_id, source_id),
        ).fetchone()
    return row is not None


def store_source(
    session_id: str,
    source_id: str,
    text: str,
    name: str = "",
    *,
    allow_replace: bool = False,
):
    now = int(time.time())

    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")

        existing = conn.execute(
            "SELECT 1 FROM sources WHERE session_id=? AND source_id=?",
            (session_id, source_id),
        ).fetchone()

        if existing and not allow_replace:
            raise ValueError("SOURCE_ID_ALREADY_EXISTS")

        if existing:
            conn.execute(
                """
                UPDATE sources
                SET name=?, text=?, created_at=?
                WHERE session_id=? AND source_id=?
                """,
                (name or source_id, text, now, session_id, source_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO sources(session_id, source_id, name, text, created_at)
                VALUES (?,?,?,?,?)
                """,
                (session_id, source_id, name or source_id, text, now),
            )

        conn.execute(
            """
            INSERT OR REPLACE INTO indexing_status
            (session_id, source_id, status, detail, pages_total, pages_done, updated_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (session_id, source_id, "pending", "", 0, 0, now),
        )


def _next_source_id(session_id: str) -> str:
    with db() as conn:
        rows = conn.execute(
            "SELECT source_id FROM sources WHERE session_id=?",
            (session_id,),
        ).fetchall()
    nums = []
    for r in rows:
        m = re.match(r"^S(\d+)$", r["source_id"])
        if m:
            nums.append(int(m.group(1)))
    nxt = (max(nums) + 1) if nums else 1
    return f"S{nxt}"


def _normalize_source_text(source_id: str, text: str) -> str:
    t = (text or "").strip()
    if not t:
        return t

    # If no markers exist, wrap as single page.
    if not re.search(r"\[S\d+:p\d+\]", t):
        return f"[{source_id}:p1]\n{t}\n"

    # If markers exist but point to another source_id, rewrite them to match.
    m = re.search(r"\[(S\d+):p\d+\]", t)
    if m and m.group(1) != source_id:
        t = re.sub(
            r"\[S\d+:p(\d+)\]",
            lambda m2: f"[{source_id}:p{m2.group(1)}]",
            t,
        )

    return t


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb + 1e-12)


def _split_pages_by_marker(text: str):
    parts = re.split(r"(?=\[S\d+:p\d+\])", (text or "").strip())
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        m = re.match(r"^\[(S\d+):p(\d+)\]", p)
        if not m:
            continue
        citation = f"{m.group(1)}:p{m.group(2)}"
        content = re.sub(r"^\[S\d+:p\d+\]\s*", "", p).strip()
        if content:
            out.append((citation, p, content))
    return out


def index_source_pages(session_id: str, source_text: str):
    pages = _split_pages_by_marker(source_text)
    if not pages:
        return

    texts_for_embed = [content for _, _, content in pages]
    emb = client.embeddings.create(model=EMBEDDING_MODEL, input=texts_for_embed)
    vecs = [d.embedding for d in emb.data]

    src = None
    if pages:
        src = pages[0][0].split(":")[0]
    if src:
        with db() as conn:
            conn.execute(
                "DELETE FROM pages WHERE session_id=? AND citation LIKE ?",
                (session_id, f"{src}:p%"),
            )

    with db() as conn:
        for (citation, full_with_marker, _), v in zip(pages, vecs):
            conn.execute(
                "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
                (session_id, citation, full_with_marker, json.dumps(v), int(time.time())),
            )


def index_source_bg(session_id: str, source_id: str, text: str):
    local_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    pages = _split_pages_by_marker(text)
    total = len(pages)

    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO indexing_status(session_id, source_id, status, detail, pages_total, pages_done, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (session_id, source_id, "pending", "", total, 0, int(time.time())),
        )
        conn.execute(
            "DELETE FROM pages WHERE session_id=? AND citation LIKE ?",
            (session_id, f"{source_id}:p%"),
        )

    try:
        if total == 0:
            with db() as conn:
                conn.execute(
                    "UPDATE indexing_status SET status=?, detail=?, updated_at=? WHERE session_id=? AND source_id=?",
                    ("ready", "", int(time.time()), session_id, source_id),
                )
            return

        done = 0
        for start in range(0, total, INDEX_BATCH_SIZE):
            batch = pages[start : start + INDEX_BATCH_SIZE]
            inputs = [content for _, _, content in batch]

            emb = local_client.embeddings.create(model=EMBEDDING_MODEL, input=inputs)
            vecs = [d.embedding for d in emb.data]

            with db() as conn:
                for (citation, full_with_marker, _), v in zip(batch, vecs):
                    conn.execute(
                        "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
                        (session_id, citation, full_with_marker, json.dumps(v), int(time.time())),
                    )

                done = min(total, start + len(batch))
                conn.execute(
                    "UPDATE indexing_status SET pages_done=?, updated_at=? WHERE session_id=? AND source_id=?",
                    (done, int(time.time()), session_id, source_id),
                )

        with db() as conn:
            conn.execute(
                "UPDATE indexing_status SET status=?, detail=?, updated_at=? WHERE session_id=? AND source_id=?",
                ("ready", "", int(time.time()), session_id, source_id),
            )

    except Exception as e:
        with db() as conn:
            conn.execute(
                "UPDATE indexing_status SET status=?, detail=?, updated_at=? WHERE session_id=? AND source_id=?",
                ("failed", str(e), int(time.time()), session_id, source_id),
            )


def retrieve_top_pages(
    session_id: str, allowed_citations: set[str], query: str, top_k: int
):
    with db() as conn:
        rows = conn.execute(
            "SELECT citation, text, emb_json FROM pages WHERE session_id=?",
            (session_id,),
        ).fetchall()

    if not rows:
        return [], []

    q_emb = client.embeddings.create(model=EMBEDDING_MODEL, input=[query]).data[
        0
    ].embedding

    scored = []
    for r in rows:
        cit = r["citation"]
        if cit not in allowed_citations:
            continue
        emb = json.loads(r["emb_json"])
        scored.append((_cosine(q_emb, emb), {"citation": cit, "text": r["text"]}))

    scored.sort(key=lambda x: x[0], reverse=True)
    picked = [row for _, row in scored[:top_k]]
    return [p["text"] for p in picked], [{"citation": p["citation"]} for p in picked]


def _allowed_citations_for_sources(session_id: str, source_ids: list[str]) -> set[str]:
    if not source_ids:
        with db() as conn:
            rows = conn.execute(
                "SELECT citation FROM pages WHERE session_id=?",
                (session_id,),
            ).fetchall()
        return {r["citation"] for r in rows}
    likes = " OR ".join(["citation LIKE ?"] * len(source_ids))
    params = [session_id] + [f"{sid}:p%" for sid in source_ids]
    with db() as conn:
        rows = conn.execute(
            f"SELECT citation FROM pages WHERE session_id=? AND ({likes})",
            params,
        ).fetchall()
    return {r["citation"] for r in rows}


def build_schema(task_type: str, n: int) -> dict:
    citations_schema = {"type": "array", "items": {"type": "string"}}

    mcq_item = {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": ["mcq"]},
            "question": {"type": "string"},
            "choices": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 4,
                "maxItems": 4,
            },
            "answer": {"type": "string", "enum": ["A", "B", "C", "D"], "maxLength": 160},
            "explanation": {"type": "string", "maxLength": 280},
            "citations": citations_schema,
        },
        "required": ["type", "question", "choices", "answer", "explanation", "citations"],
        "additionalProperties": False,
    }

    short_item = {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": ["short"]},
            "question": {"type": "string"},
            "answer": {"type": "string", "maxLength": 160},
            "explanation": {"type": "string", "maxLength": 280},
            "citations": citations_schema,
        },
        "required": ["type", "question", "answer", "explanation", "citations"],
        "additionalProperties": False,
    }

    flashcard = {
        "type": "object",
        "properties": {
            "term": {"type": "string"},
            "definition": {"type": "string"},
            "example": {"type": "string"},
            "citations": citations_schema,
        },
        "required": ["term", "definition", "example", "citations"],
        "additionalProperties": False,
    }

    if task_type == "quiz_json":
        return {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"anyOf": [mcq_item, short_item]},
                    "minItems": n,
                    "maxItems": n,
                }
            },
            "required": ["items"],
            "additionalProperties": False,
        }

    if task_type == "tricky_json":
        return {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": mcq_item,
                    "minItems": n,
                    "maxItems": n,
                }
            },
            "required": ["items"],
            "additionalProperties": False,
        }

    if task_type == "flashcards_json":
        return {
            "type": "object",
            "properties": {
                "cards": {
                    "type": "array",
                    "items": flashcard,
                    "minItems": n,
                    "maxItems": n,
                }
            },
            "required": ["cards"],
            "additionalProperties": False,
        }

    return {"type": "object", "properties": {}, "additionalProperties": True}


def _allowed_citations_from_sources(sources_text: str) -> set[str]:
    return set(re.findall(r"\bS\d+:p\d+\b", sources_text or ""))


def _validate_count(task_type: str, obj: dict, n: int):
    if task_type in ("quiz_json", "tricky_json"):
        items = obj.get("items")
        if not isinstance(items, list) or len(items) != n:
            raise ValueError(f"items count must be exactly {n}")
    elif task_type == "flashcards_json":
        cards = obj.get("cards")
        if not isinstance(cards, list) or len(cards) != n:
            raise ValueError(f"cards count must be exactly {n}")


def _item_is_not_in_sources(task_type: str, it: dict) -> bool:
    if task_type == "flashcards_json":
        return any(
            isinstance(it.get(k), str) and it.get(k, "").strip() == "NOT_IN_SOURCES"
            for k in ("term", "definition", "example")
        )
    ans = it.get("answer", "")
    return isinstance(ans, str) and ans.strip() == "NOT_IN_SOURCES"


def _validate_citations(task_type: str, obj: dict, allowed: set[str]):
    if task_type in ("quiz_json", "tricky_json"):
        items = obj.get("items", [])
        key = "items"
    elif task_type == "flashcards_json":
        items = obj.get("cards", [])
        key = "cards"
    else:
        return

    if not isinstance(items, list):
        raise ValueError(f"{key} is not a list")

    for idx, it in enumerate(items, start=1):
        citations = it.get("citations", [])
        if not isinstance(citations, list):
            raise ValueError(f"{key}[{idx}].citations is not a list")

        if _item_is_not_in_sources(task_type, it):
            if len(citations) != 0:
                raise ValueError(
                    f"{key}[{idx}] has NOT_IN_SOURCES but citations not empty"
                )
            continue

        if len(citations) == 0:
            raise ValueError(f"{key}[{idx}] missing citations")

        bad = [c for c in citations if c not in allowed]
        if bad:
            raise ValueError(f"{key}[{idx}] has invalid citations: {bad[:5]}")


def _safe_int(x, default=5, min_v=1, max_v=50):
    try:
        v = int(x)
    except Exception:
        v = default
    return max(min_v, min(max_v, v))


def _choice_label(index: int) -> str:
    return chr(ord("A") + index)


def _strip_choice_label(choice: str) -> str:
    return re.sub(r"^\s*[A-D]\s*[\)\.\:\-]\s*", "", str(choice or "").strip(), flags=re.IGNORECASE)


def _shuffle_mcq_items(task_type: str, obj: dict, shuffle_choices: bool) -> dict:
    if not shuffle_choices or task_type not in ("quiz_json", "tricky_json"):
        return obj

    items = obj.get("items")
    if not isinstance(items, list):
        return obj

    for idx, item in enumerate(items):
        if not isinstance(item, dict) or item.get("type") != "mcq":
            continue

        choices = item.get("choices")
        answer = str(item.get("answer") or "").strip().upper()
        if not isinstance(choices, list) or len(choices) != 4 or answer not in {"A", "B", "C", "D"}:
            continue

        correct_index = ord(answer) - ord("A")
        if correct_index < 0 or correct_index >= len(choices):
            continue

        normalized_choices = [_strip_choice_label(choice) for choice in choices]
        if any(not choice for choice in normalized_choices):
            continue

        seed_text = json.dumps(
            {
                "task_type": task_type,
                "index": idx,
                "question": item.get("question", ""),
                "answer": answer,
                "choices": normalized_choices,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        rng = random.Random(seed_text)
        order = list(range(len(normalized_choices)))
        rng.shuffle(order)

        shuffled_choices = [normalized_choices[i] for i in order]
        item["choices"] = [
            f"{_choice_label(i)}) {choice}" for i, choice in enumerate(shuffled_choices)
        ]
        item["answer"] = _choice_label(order.index(correct_index))

    return obj


def _serialize_output(task_type: str, obj: dict, shuffle_choices: bool) -> tuple[dict, str]:
    processed = _shuffle_mcq_items(task_type, obj, shuffle_choices)
    return processed, json.dumps(processed, ensure_ascii=False)


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/sessions")
def list_sessions():
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "MISSING_OR_INVALID_SESSION_ID"}), 400

    with db() as conn:
        row = conn.execute(
            "SELECT session_id, name, created_at, updated_at FROM sessions WHERE session_id=?",
            (session_id,),
        ).fetchone()
    return jsonify({"sessions": [dict(row)] if row else []})


@app.post("/sessions")
def create_session():
    data = request.get_json(force=True, silent=True) or {}
    current_sid = get_session_id_from_request(request)
    if not current_sid:
        return jsonify({"error": "MISSING_OR_INVALID_SESSION_ID"}), 400

    sid = (data.get("session_id") or current_sid).strip()
    if not is_valid_session_id(sid):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    if sid != current_sid:
        return jsonify({"error": "SESSION_ID_MISMATCH"}), 403

    raw_name = data["name"] if "name" in data else sid
    name = _normalize_session_name(raw_name)
    now = int(time.time())
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions(session_id, name, created_at, updated_at) VALUES (?,?,?,?)",
            (sid, name, now, now),
        )
        conn.execute(
            "UPDATE sessions SET name=?, updated_at=? WHERE session_id=?",
            (name, now, sid),
        )
    return jsonify({"ok": True, "session_id": sid})


@app.post("/sessions/set-name")
def set_session_name():
    data = request.get_json(force=True, silent=True) or {}
    current_sid = get_session_id_from_request(request)
    if not current_sid:
        return jsonify({"error": "MISSING_OR_INVALID_SESSION_ID"}), 400

    sid = (data.get("session_id") or current_sid).strip()
    if not is_valid_session_id(sid):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    if sid != current_sid:
        return jsonify({"error": "SESSION_ID_MISMATCH"}), 403

    name = _set_session_name(sid, data.get("name", ""))
    return jsonify({"ok": True, "session_id": sid, "name": name})


@app.post("/sessions/rename")
def rename_session():
    data = request.get_json(force=True, silent=True) or {}
    current_sid = get_session_id_from_request(request)
    if not current_sid:
        return jsonify({"error": "MISSING_OR_INVALID_SESSION_ID"}), 400

    old = (data.get("from") or "").strip()
    new = (data.get("to") or "").strip()

    if not is_valid_session_id(old) or not is_valid_session_id(new):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    if old != current_sid:
        return jsonify({"error": "SESSION_ID_MISMATCH"}), 403

    if old == new:
        return jsonify({"ok": True, "from": old, "to": new, "unchanged": True})

    with db() as conn:
        old_exists = conn.execute(
            "SELECT 1 FROM sessions WHERE session_id=?",
            (old,),
        ).fetchone()
        if not old_exists:
            return jsonify({"error": "SESSION_NOT_FOUND", "session_id": old}), 404

        new_exists = conn.execute(
            "SELECT 1 FROM sessions WHERE session_id=?",
            (new,),
        ).fetchone()
        if new_exists:
            return jsonify({"error": "SESSION_ALREADY_EXISTS"}), 409

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE sessions SET session_id=?, name=?, updated_at=? WHERE session_id=?",
            (new, new, int(time.time()), old),
        )
        for t in ("sources", "pages", "indexing_status"):
            conn.execute(f"UPDATE {t} SET session_id=? WHERE session_id=?", (new, old))

    return jsonify({"ok": True, "from": old, "to": new})


@app.delete("/sessions/<sid>")
def delete_session(sid):
    current_sid = get_session_id_from_request(request)
    if not current_sid:
        return jsonify({"error": "MISSING_OR_INVALID_SESSION_ID"}), 400

    sid = (sid or "").strip()
    if not is_valid_session_id(sid):
        return jsonify({"error": "INVALID_OR_PROTECTED_SESSION"}), 400
    if sid != current_sid:
        return jsonify({"error": "SESSION_ID_MISMATCH"}), 403

    with db() as conn:
        for t in ("sources", "pages", "indexing_status"):
            conn.execute(f"DELETE FROM {t} WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM sessions WHERE session_id=?", (sid,))
    return jsonify({"ok": True})


@app.get("/sources")
def list_sources():
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    with db() as conn:
        rows = conn.execute(
            """
            SELECT s.source_id, s.name, s.created_at,
                   COALESCE(i.status, 'pending') AS status,
                   COALESCE(i.detail, '') AS detail,
                   COALESCE(i.pages_done, 0) AS pages_done,
                   COALESCE(i.pages_total, 0) AS pages_total
            FROM sources s
            LEFT JOIN indexing_status i
              ON i.session_id = s.session_id AND i.source_id = s.source_id
            WHERE s.session_id=?
            ORDER BY s.source_id
            """,
            (session_id,),
        ).fetchall()
    items = [
        {
            "source_id": r["source_id"],
            "name": r["name"],
            "created_at": r["created_at"],
            "status": r["status"],
            "detail": r["detail"],
            "pages_done": r["pages_done"],
            "pages_total": r["pages_total"],
        }
        for r in rows
    ]
    return jsonify({"session_id": session_id, "sources": items})


@app.get("/sources/<source_id>")
def get_source(source_id):
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    with db() as conn:
        r = conn.execute(
            "SELECT text FROM sources WHERE session_id=? AND source_id=?",
            (session_id, source_id),
        ).fetchone()
    if not r:
        return jsonify({"error": "SOURCE_NOT_FOUND", "source_id": source_id}), 404
    return jsonify(
        {"session_id": session_id, "source_id": source_id, "text": r["text"]}
    )


@app.delete("/sources/<source_id>")
def delete_source(source_id):
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    with db() as conn:
        deleted = conn.execute(
            "DELETE FROM sources WHERE session_id=? AND source_id=?",
            (session_id, source_id),
        ).rowcount

        if deleted == 0:
            return jsonify({"error": "SOURCE_NOT_FOUND", "source_id": source_id}), 404

        conn.execute(
            "DELETE FROM pages WHERE session_id=? AND citation LIKE ?",
            (session_id, f"{source_id}:p%"),
        )
        conn.execute(
            "DELETE FROM indexing_status WHERE session_id=? AND source_id=?",
            (session_id, source_id),
        )
    return jsonify({"ok": True, "session_id": session_id, "deleted": source_id})


@app.delete("/sources")
def clear_sources():
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    with db() as conn:
        deleted_sources = conn.execute(
            "DELETE FROM sources WHERE session_id=?",
            (session_id,),
        ).rowcount
        deleted_pages = conn.execute(
            "DELETE FROM pages WHERE session_id=?",
            (session_id,),
        ).rowcount
        deleted_indexing = conn.execute(
            "DELETE FROM indexing_status WHERE session_id=?",
            (session_id,),
        ).rowcount
    return jsonify(
        {
            "ok": True,
            "session_id": session_id,
            "cleared": True,
            "deleted_sources": deleted_sources,
            "deleted_pages": deleted_pages,
            "deleted_indexing": deleted_indexing,
        }
    )


@app.post("/sources")
def add_source_text():
    data = request.get_json(force=True, silent=True) or {}
    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400

    source_id = (data.get("source_id") or "").strip()
    text = (data.get("text") or "").strip()
    name = (data.get("name") or "").strip()

    if not text:
        return jsonify({"error": "EMPTY_SOURCE_TEXT"}), 400

    if not source_id:
        source_id = _next_source_id(session_id)

    if not SOURCE_ID_RE.match(source_id):
        return (
            jsonify(
                {
                    "error": "INVALID_SOURCE_ID",
                    "expected": "S<number>",
                    "source_id": source_id,
                }
            ),
            400,
        )

    normalized = _normalize_source_text(source_id, text)
    truncated = False
    if len(normalized) > MAX_SOURCE_CHARS:
        normalized = normalized[:MAX_SOURCE_CHARS]
        truncated = True

    try:
        store_source(
            session_id=session_id,
            source_id=source_id,
            text=normalized,
            name=name or source_id,
            allow_replace=False,
        )
    except ValueError as e:
        if str(e) == "SOURCE_ID_ALREADY_EXISTS":
            return (
                jsonify({"error": "SOURCE_ID_ALREADY_EXISTS", "source_id": source_id}),
                409,
            )
        raise

    Thread(
        target=index_source_bg,
        args=(session_id, source_id, normalized),
        daemon=True,
    ).start()
    return (
        jsonify(
            {
                "session_id": session_id,
                "source_id": source_id,
                "name": name or source_id,
                "text": normalized,
                "truncated": truncated,
                "indexing": {"status": "pending"},
            }
        ),
        201,
    )


@app.route("/generate", methods=["POST", "OPTIONS"])
@rate_limit
def generate():
    # Browsers send an OPTIONS preflight request before POST.
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(force=True, silent=True) or {}
    task_type = (data.get("task_type") or "quiz_json").strip()
    n = _safe_int(data.get("n", 5), default=5)
    sources = data.get("sources", "")
    language = (data.get("language") or "en").strip().lower()
    if language not in ("en", "ar", "tr"):
        language = "en"

    difficulty = (data.get("difficulty") or "medium").strip().lower()
    if difficulty not in ("easy", "medium", "hard"):
        difficulty = "medium"

    mode = (data.get("mode") or "mixed").strip()
    shuffle_choices = bool(data.get("shuffle_choices", True))
    shuffle_cards = bool(data.get("shuffle_cards", True))

    focus_query = (data.get("focus_query") or "").strip()
    strict_focus = data.get("strict_focus", True)
    if isinstance(strict_focus, str):
        strict_focus = strict_focus.strip().lower() in ("1", "true", "yes", "on")
    else:
        strict_focus = bool(strict_focus)

    if task_type not in PRESETS:
        return jsonify({"error": "Unknown task_type", "task_type": task_type, "allowed": list(PRESETS.keys())}), 400

    try:
        session_id = get_session_id()
        if not session_id:
            return jsonify({"error": "INVALID_SESSION_ID"}), 400
        source_ids = data.get("source_ids") or []
        sources_text = sources

        if isinstance(source_ids, list) and len(source_ids) > 0:
            placeholders = ",".join(["?"] * len(source_ids))
            with db() as conn:
                rows = conn.execute(
                    f"SELECT source_id, status, detail FROM indexing_status WHERE session_id=? AND source_id IN ({placeholders})",
                    [session_id] + source_ids,
                ).fetchall()
            st = {r["source_id"]: (r["status"], r["detail"]) for r in rows}
            not_ready = [
                sid
                for sid in source_ids
                if st.get(sid, ("pending", ""))[0] != "ready"
            ]
            if not_ready:
                return jsonify(
                    {
                        "error": "SOURCES_NOT_INDEXED",
                        "not_ready": [
                            {"source_id": sid, "status": st.get(sid, ("pending", ""))[0]}
                            for sid in not_ready
                        ],
                    }
                ), 409
            with db() as conn:
                rows = conn.execute(
                    f"SELECT source_id, text FROM sources WHERE session_id=? AND source_id IN ({placeholders})",
                    [session_id] + source_ids,
                ).fetchall()
            got = {r["source_id"]: r["text"] for r in rows}
            missing = [sid for sid in source_ids if sid not in got]
            if missing:
                return jsonify({"error": "MISSING_SOURCE_IDS", "missing": missing}), 400
            sources_text = "\n\n".join(got[sid] for sid in source_ids).strip()
        else:
            if not (sources_text or "").strip():
                with db() as conn:
                    rows = conn.execute(
                        "SELECT text FROM sources WHERE session_id=?",
                        (session_id,),
                    ).fetchall()
                if rows:
                    sources_text = "\n\n".join(r["text"] for r in rows).strip()

        retrieved = []
        if focus_query:
            allowed = _allowed_citations_for_sources(session_id, source_ids)
            if not allowed:
                return jsonify({"error": "SOURCES_NOT_INDEXED_YET"}), 409
            top_texts, retrieved = retrieve_top_pages(
                session_id=session_id,
                allowed_citations=allowed,
                query=focus_query,
                top_k=TOP_K_PAGES,
            )
            if top_texts:
                sources_text = "\n\n".join(top_texts).strip()

        if len(sources_text) > MAX_SOURCES_CHARS_PER_REQUEST:
            return jsonify(
                {
                    "error": "SOURCES_TOO_LARGE",
                    "details": f"Selected sources are too large ({len(sources_text)} chars).",
                    "limit": MAX_SOURCES_CHARS_PER_REQUEST,
                    "hint": "Reduce selected sources/pages, or split PDFs into smaller parts.",
                }
            ), 413

        prompt = PRESETS[task_type].format(
            n=n, sources=sources_text, language=language, difficulty=difficulty
        )
        prompt = (
            f"MODE: {mode}\n"
            f"SHUFFLE_CHOICES: {str(shuffle_choices).lower()}\n"
            f"SHUFFLE_CARDS: {str(shuffle_cards).lower()}\n\n"
            + prompt
        )
        if focus_query:
            prompt = (
                f"FOCUS_QUERY: {focus_query}\n"
                f"STRICT_FOCUS: {str(strict_focus).lower()}\n\n"
                + prompt
                + "\n\n"
                + (
                    "Rules for focus:\n"
                    "- If STRICT_FOCUS is true: every item MUST be directly about the focus query.\n"
                    "- If STRICT_FOCUS is false: prioritize focus, but may include broader items from sources.\n"
                )
            )

        app.logger.info("generate task=%s n=%s session=%s", task_type, n, session_id)
    except KeyError as e:
        # This usually means the prompt template contains unescaped braces.
        return jsonify({"error": "TEMPLATE_FORMAT_ERROR", "details": str(e), "task_type": task_type}), 500

    try:
        schema = build_schema(task_type, n)
        text_format = {
            "format": {
                "type": "json_schema",
                "name": f"{task_type}_v1",
                "schema": schema,
                "strict": True,
            }
        }

        system_msg = (
            "You generate study materials strictly from SOURCES.\n"
            "Citations MUST be copied exactly from markers like [S1:p3] present in SOURCES; never invent citations.\n"
            "If info is missing in sources: use NOT_IN_SOURCES and citations [].\n"
            "Return only JSON matching the required schema."
        )

        try:
            resp = client.responses.create(
                model=GENERATION_MODEL,
                input=[
                    {
                        "role": "system",
                        "content": [{"type": "input_text", "text": system_msg}],
                    },
                    {"role": "user", "content": [{"type": "input_text", "text": prompt}]},
                ],
                **GENERATION_KW,
                text=text_format,
            )
        except BadRequestError:
            resp = client.responses.create(
                model=GENERATION_MODEL,
                input=[
                    {
                        "role": "system",
                        "content": [{"type": "input_text", "text": system_msg}],
                    },
                    {"role": "user", "content": [{"type": "input_text", "text": prompt}]},
                ],
                **GENERATION_KW,
                text={"format": {"type": "json_object"}},
            )

        out = resp.output_text
        try:
            obj = json.loads(out)
        except Exception as e:
            return jsonify(
                {"error": "MODEL_OUTPUT_NOT_JSON", "details": str(e), "raw": out[:2000]}
            ), 502

        allowed = _allowed_citations_from_sources(sources_text)
        try:
            _validate_count(task_type, obj, n)
            _validate_citations(task_type, obj, allowed)
        except Exception as e:
            allowed_list = sorted(list(allowed))
            repair_prompt = PRESETS["repair_json"].format(
                allowed=allowed_list,
                bad_output=out,
                sources=sources_text,
            )

            try:
                if MAX_REPAIR_TRIES < 1:
                    raise RuntimeError("MAX_REPAIR_TRIES is 0")

                resp2 = client.responses.create(
                    model=GENERATION_MODEL,
                    input=repair_prompt,
                    **GENERATION_KW,
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": f"{task_type}_repair",
                            "schema": schema,
                            "strict": True,
                        }
                    },
                )
                out2 = resp2.output_text
                obj2 = json.loads(out2)

                _validate_count(task_type, obj2, n)
                _validate_citations(task_type, obj2, allowed)
                obj2, out2 = _serialize_output(task_type, obj2, shuffle_choices)
                return jsonify(
                    {
                        "task_type": task_type,
                        "output": out2,
                        "output_json": obj2,
                        "repaired": True,
                    }
                )

            except Exception:
                return jsonify(
                    {
                        "error": "CITATION_VALIDATION_FAILED",
                        "details": str(e),
                        "allowed_count": len(allowed),
                    }
                ), 422

        obj, out = _serialize_output(task_type, obj, shuffle_choices)
        return jsonify(
            {
                "task_type": task_type,
                "output": out,
                "output_json": obj,
                "retrieved": retrieved,
            }
        )

    except AuthenticationError as e:
        return jsonify({"error": "AUTH_ERROR", "details": str(e)}), 401
    except RateLimitError as e:
        return jsonify({"error": "RATE_LIMIT", "details": str(e)}), 429
    except BadRequestError as e:
        return jsonify({"error": "BAD_REQUEST", "details": str(e)}), 400
    except APIConnectionError as e:
        return jsonify({"error": "API_CONNECTION", "details": str(e)}), 502
    except APIStatusError as e:
        return jsonify({"error": "API_STATUS", "status_code": e.status_code, "details": str(e)}), 502
    except Exception as e:
        return jsonify({"error": "SERVER_ERROR", "type": type(e).__name__, "details": str(e)}), 500


@app.get("/debug/openai")
def debug_openai():
    try:
        emb = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=["test connection"],
        )

        resp = client.responses.create(
            model=GENERATION_MODEL,
            input="Reply with exactly: OK",
            **GENERATION_KW,
        )

        return jsonify(
            {
                "ok": True,
                "embedding_model": EMBEDDING_MODEL,
                "generation_model": GENERATION_MODEL,
                "embedding_dims": len(emb.data[0].embedding),
                "response_text": resp.output_text,
            }
        )

    except AuthenticationError as e:
        return jsonify({"ok": False, "error": "AUTH_ERROR", "details": str(e)}), 401
    except RateLimitError as e:
        return jsonify({"ok": False, "error": "RATE_LIMIT", "details": str(e)}), 429
    except BadRequestError as e:
        return jsonify({"ok": False, "error": "BAD_REQUEST", "details": str(e)}), 400
    except APIConnectionError as e:
        return jsonify({"ok": False, "error": "API_CONNECTION", "details": str(e)}), 502
    except APIStatusError as e:
        return jsonify(
            {
                "ok": False,
                "error": "API_STATUS",
                "status_code": e.status_code,
                "details": str(e),
            }
        ), 502
    except Exception as e:
        return jsonify(
            {
                "ok": False,
                "error": "SERVER_ERROR",
                "type": type(e).__name__,
                "details": str(e),
            }
        ), 500


@app.route("/upload", methods=["POST", "OPTIONS"])
def upload():
    if request.method == "OPTIONS":
        return ("", 204)

    if "file" not in request.files:
        return jsonify({"error": "No file field named 'file'"}), 400

    session_id = get_session_id()
    if not session_id:
        return jsonify({"error": "INVALID_SESSION_ID"}), 400
    f = request.files["file"]
    original_filename = (f.filename or "").strip()
    filename = original_filename.lower()

    # Use the frontend-provided source_id when present, otherwise generate the next one.
    source_id = (request.form.get("source_id") or "").strip()
    if not source_id:
        source_id = _next_source_id(session_id)
    if not SOURCE_ID_RE.match(source_id):
        return (
            jsonify(
                {
                    "error": "INVALID_SOURCE_ID",
                    "expected": "S<number>",
                    "source_id": source_id,
                }
            ),
            400,
        )

    if filename.endswith(".txt"):
        text = f.read().decode("utf-8", errors="ignore")
        combined = f"[{source_id}:p1]\n{text}\n"
        truncated = False
        if len(combined) > MAX_SOURCE_CHARS:
            combined = combined[:MAX_SOURCE_CHARS]
            truncated = True
        try:
            store_source(
                session_id,
                source_id,
                combined,
                name=f.filename or source_id,
                allow_replace=False,
            )
        except ValueError as e:
            if str(e) == "SOURCE_ID_ALREADY_EXISTS":
                return (
                    jsonify(
                        {"error": "SOURCE_ID_ALREADY_EXISTS", "source_id": source_id}
                    ),
                    409,
                )
            raise
        auto_session_name = _maybe_auto_title_session_from_filename(session_id, original_filename)
        Thread(
            target=index_source_bg,
            args=(session_id, source_id, combined),
            daemon=True,
        ).start()
        return jsonify(
            {
                "session_id": session_id,
                "source_id": source_id,
                "text": combined,
                "truncated": truncated,
                "session_name": auto_session_name,
                "indexing": {"status": "pending"},
            }
        )

    if filename.endswith(".pdf"):
        # Prefer pypdf for PDF text extraction.
        try:
            from pypdf import PdfReader
        except Exception:
            # Keep the older fallback for environments that still use PyPDF2.
            from PyPDF2 import PdfReader  # type: ignore

        reader = PdfReader(f)
        total_pages = len(reader.pages)
        truncated = False
        parts = []
        for i, page in enumerate(reader.pages, start=1):
            if i > MAX_PDF_PAGES:
                truncated = True
                break
            page_text = page.extract_text() or ""
            if len(page_text) > MAX_PAGE_CHARS:
                page_text = page_text[:MAX_PAGE_CHARS]
                truncated = True
            parts.append(f"[{source_id}:p{i}]\n{page_text}".strip())
        combined = "\n\n".join(parts).strip()
        if len(combined) > MAX_SOURCE_CHARS:
            combined = combined[:MAX_SOURCE_CHARS]
            truncated = True
        try:
            store_source(
                session_id,
                source_id,
                combined,
                name=f.filename or source_id,
                allow_replace=False,
            )
        except ValueError as e:
            if str(e) == "SOURCE_ID_ALREADY_EXISTS":
                return (
                    jsonify(
                        {"error": "SOURCE_ID_ALREADY_EXISTS", "source_id": source_id}
                    ),
                    409,
                )
            raise
        auto_session_name = _maybe_auto_title_session_from_filename(session_id, original_filename)
        Thread(
            target=index_source_bg,
            args=(session_id, source_id, combined),
            daemon=True,
        ).start()
        return jsonify(
            {
                "session_id": session_id,
                "source_id": source_id,
                "text": combined,
                "session_name": auto_session_name,
                "meta": {
                    "pages_total": total_pages,
                    "pages_kept": min(total_pages, MAX_PDF_PAGES),
                    "truncated": truncated,
                },
                "indexing": {"status": "pending"},
            }
        )

    return jsonify({"error": "Unsupported file type. Use .pdf or .txt"}), 400


if __name__ == "__main__":
    debug = os.getenv("DEBUG", "0").strip().lower() in ("1", "true", "yes", "on")
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    app.run(debug=debug, host=host, port=port)
