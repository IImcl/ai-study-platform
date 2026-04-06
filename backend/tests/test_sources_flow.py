import io
import time


def test_upload_then_sources_list(client, monkeypatch):
    import app as appmod

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
        headers={"X-Session-Id": "local"},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    js = r.get_json()
    assert js["source_id"] == "S1"

    r2 = client.get("/sources", headers={"X-Session-Id": "local"})
    assert r2.status_code == 200
    out = r2.get_json()
    assert out["session_id"] == "local"
    assert any(s["source_id"] == "S1" for s in out["sources"])
