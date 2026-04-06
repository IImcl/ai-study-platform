import json


class FakeResp:
    def __init__(self, text):
        self.output_text = text


def test_generate_repair_path(client, monkeypatch):
    import app as appmod

    with appmod.db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sources(session_id, source_id, name, text, created_at) VALUES (?,?,?,?,?)",
            ("local", "S1", "S1", "[S1:p1]\nhello", 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO indexing_status(session_id, source_id, status, detail, pages_total, pages_done, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            ("local", "S1", "ready", "", 1, 1, 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
            ("local", "S1:p1", "[S1:p1]\nhello", "[0.0,0.0]", 0),
        )

    bad = json.dumps(
        {
            "cards": [
                {"term": "x", "definition": "y", "example": "z", "citations": ["S1:p1"]},
                {"term": "a", "definition": "b", "example": "c", "citations": []},
            ]
        }
    )
    good = json.dumps(
        {
            "cards": [
                {"term": "x", "definition": "y", "example": "z", "citations": ["S1:p1"]},
                {"term": "a", "definition": "b", "example": "c", "citations": ["S1:p1"]},
            ]
        }
    )

    calls = {"n": 0}

    def fake_create(**kwargs):
        calls["n"] += 1
        return FakeResp(bad if calls["n"] == 1 else good)

    monkeypatch.setattr(appmod.client.responses, "create", fake_create)

    payload = {"task_type": "flashcards_json", "n": 2, "source_ids": ["S1"]}
    r = client.post("/generate", json=payload, headers={"X-Session-Id": "local"})
    assert r.status_code == 200
    out = r.get_json()
    assert "output" in out
    obj = json.loads(out["output"])
    assert obj["cards"][1]["citations"] == ["S1:p1"]
