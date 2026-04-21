import io
import time


def test_upload_then_sources_list(client, monkeypatch):
    import app as appmod
    session_id = "chat_test_sources"

    def fake_index_bg(session_id, source_id, text):
        with appmod.db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO indexing_status(session_id, source_id, status, detail, pages_total, pages_done, updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (session_id, source_id, "ready", "", 1, 1, int(time.time())),
            )
            conn.execute(
                "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
                (session_id, f"{source_id}:p1", f"[{source_id}:p1]\nhello", "[0.0,0.0]", int(time.time())),
            )

    monkeypatch.setattr(appmod, "index_source_bg", fake_index_bg)

    data = {
        "file": (io.BytesIO(b"hello"), "courses.txt"),
        "source_id": "S1",
    }
    r = client.post(
        "/upload",
        data=data,
        headers={"X-Session-Id": session_id},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    js = r.get_json()
    assert js["source_id"] == "S1"

    r2 = client.get("/sources", headers={"X-Session-Id": session_id})
    assert r2.status_code == 200
    out = r2.get_json()
    assert out["session_id"] == session_id
    assert any(s["source_id"] == "S1" for s in out["sources"])


def test_long_manual_source_is_chunked_before_indexing(client, monkeypatch):
    import app as appmod

    session_id = "chat_test_chunking"
    calls = []

    class FakeEmbeddings:
        def create(self, *, model, input):
            inputs = list(input)
            calls.append(inputs)
            data = [
                type("EmbeddingItem", (), {"embedding": [float(idx), 0.0]})()
                for idx, _ in enumerate(inputs, start=1)
            ]
            return type("EmbeddingResponse", (), {"data": data})()

    class FakeOpenAI:
        def __init__(self, api_key=None):
            self.embeddings = FakeEmbeddings()

    class ImmediateThread:
        def __init__(self, target, args=(), kwargs=None, daemon=None):
            self._target = target
            self._args = args
            self._kwargs = kwargs or {}

        def start(self):
            self._target(*self._args, **self._kwargs)

    monkeypatch.setattr(appmod, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(appmod, "Thread", ImmediateThread)
    monkeypatch.setattr(appmod, "MAX_EMBED_INPUT_CHARS", 220)
    monkeypatch.setattr(appmod, "MIN_EMBED_CHUNK_CHARS", 80)

    paragraph = (
        "Dynamic host configuration protocol assigns addresses to clients and "
        "coordinates lease timing, relay behavior, and renewal flow across the network."
    )
    long_text = "\n\n".join(paragraph for _ in range(8))

    response = client.post(
        "/sources",
        json={"source_id": "S1", "name": "Long notes", "text": long_text},
        headers={"X-Session-Id": session_id},
    )
    assert response.status_code == 201, response.get_data(as_text=True)

    with appmod.db() as conn:
        source_row = conn.execute(
            "SELECT text FROM sources WHERE session_id=? AND source_id=?",
            (session_id, "S1"),
        ).fetchone()
        status_row = conn.execute(
            "SELECT status, pages_total, pages_done, detail FROM indexing_status WHERE session_id=? AND source_id=?",
            (session_id, "S1"),
        ).fetchone()
        page_rows = conn.execute(
            "SELECT citation, text FROM pages WHERE session_id=? AND citation LIKE ? ORDER BY citation",
            (session_id, "S1:p%"),
        ).fetchall()

    stored_text = source_row["text"]
    assert "[S1:p1]" in stored_text
    assert "[S1:p2]" in stored_text
    assert status_row["status"] == "ready"
    assert status_row["pages_total"] == len(page_rows)
    assert status_row["pages_done"] == len(page_rows)
    assert status_row["detail"] == ""
    assert len(page_rows) >= 2
    assert {row["citation"] for row in page_rows} == {f"S1:p{idx}" for idx in range(1, len(page_rows) + 1)}

    assert calls
    flattened = [chunk for batch in calls for chunk in batch]
    assert flattened
    assert all(len(chunk) <= appmod.MAX_EMBED_INPUT_CHARS for chunk in flattened)
