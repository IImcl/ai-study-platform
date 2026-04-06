import os
import sys
import importlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Important: isolate test database
@pytest.fixture(autouse=True)
def _test_env(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.delenv("DB_PATH", raising=False)
    monkeypatch.setenv("DEBUG", "0")
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "9999")
    yield


@pytest.fixture()
def client():
    if "app" in sys.modules:
        app_module = importlib.reload(sys.modules["app"])
    else:
        app_module = importlib.import_module("app")
    return app_module.app.test_client()
