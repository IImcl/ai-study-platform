import json


class FakeResp:
    def __init__(self, text):
        self.output_text = text


def test_generate_repair_path(client, monkeypatch):
    import app as appmod
    session_id = "chat_test_repair"

    with appmod.db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sources(session_id, source_id, name, text, created_at) VALUES (?,?,?,?,?)",
            (session_id, "S1", "S1", "[S1:p1]\nhello", 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO indexing_status(session_id, source_id, status, detail, pages_total, pages_done, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (session_id, "S1", "ready", "", 1, 1, 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
            (session_id, "S1:p1", "[S1:p1]\nhello", "[0.0,0.0]", 0),
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
    r = client.post("/generate", json=payload, headers={"X-Session-Id": session_id})
    assert r.status_code == 200
    out = r.get_json()
    assert "output" in out
    obj = json.loads(out["output"])
    assert obj["cards"][1]["citations"] == ["S1:p1"]


def test_generate_repairs_low_value_metadata_question(client, monkeypatch):
    import app as appmod

    session_id = "chat_test_quality_repair"
    source_text = "\n\n".join(
        [
            "[S1:p1]\nPublished by Example University Press in 2026. ISBN 123-456-789.",
            "[S1:p2]\nThe platform transforms uploaded study materials into source-grounded quizzes, flashcards, and tricky questions through indexing and retrieval.",
        ]
    )

    with appmod.db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sources(session_id, source_id, name, text, created_at) VALUES (?,?,?,?,?)",
            (session_id, "S1", "S1", source_text, 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO indexing_status(session_id, source_id, status, detail, pages_total, pages_done, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (session_id, "S1", "ready", "", 2, 2, 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
            (session_id, "S1:p1", "[S1:p1]\nPublished by Example University Press in 2026. ISBN 123-456-789.", "[0.0,0.0]", 0),
        )
        conn.execute(
            "INSERT OR REPLACE INTO pages(session_id, citation, text, emb_json, created_at) VALUES (?,?,?,?,?)",
            (session_id, "S1:p2", "[S1:p2]\nThe platform transforms uploaded study materials into source-grounded quizzes, flashcards, and tricky questions through indexing and retrieval.", "[1.0,0.0]", 0),
        )

    weak = json.dumps(
        {
            "items": [
                {
                    "type": "mcq",
                    "question": "Which press published the source?",
                    "choices": [
                        "A) Example University Press",
                        "B) Study Platform Press",
                        "C) Retrieval Press",
                        "D) Quiz Press",
                    ],
                    "answer": "A",
                    "explanation": "The title page lists the publisher.",
                    "citations": ["S1:p1"],
                }
            ]
        }
    )
    repaired = json.dumps(
        {
            "items": [
                {
                    "type": "mcq",
                    "question": "What is the main purpose of the platform described in the source?",
                    "choices": [
                        "A) To publish books",
                        "B) To turn uploaded study material into grounded study tools",
                        "C) To store ISBN records",
                        "D) To replace source citations",
                    ],
                    "answer": "B",
                    "explanation": "The source explains that it creates grounded revision tools from uploaded material.",
                    "citations": ["S1:p2"],
                }
            ]
        }
    )

    calls = {"n": 0}

    def fake_create(**kwargs):
        calls["n"] += 1
        return FakeResp(weak if calls["n"] == 1 else repaired)

    monkeypatch.setattr(appmod.client.responses, "create", fake_create)

    payload = {"task_type": "quiz_json", "n": 1, "source_ids": ["S1"]}
    response = client.post("/generate", json=payload, headers={"X-Session-Id": session_id})
    assert response.status_code == 200, response.get_data(as_text=True)
    data = response.get_json()
    assert data["repaired"] is True
    assert data["quality_repaired"] is True

    output = json.loads(data["output"])
    assert "purpose" in output["items"][0]["question"].lower()
    assert output["items"][0]["citations"] == ["S1:p2"]
