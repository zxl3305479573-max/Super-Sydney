"""Sydney optional sync API. The desktop app remains usable without this service."""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


DATA_DIR = Path(os.environ.get("SYDNEY_CLOUD_DATA", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "sydney-cloud.db"
DATA_DIR.mkdir(parents=True, exist_ok=True)
API_TOKEN = os.environ.get("SYDNEY_CLOUD_TOKEN", "").strip()

app = FastAPI(title="Sydney Cloud Sync", version="0.1.0")


def require_token(authorization: str = Header(default="")) -> None:
    """采集数据含窗口标题和文件路径：没配 SYDNEY_CLOUD_TOKEN 时数据接口一律不开放。"""
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="SYDNEY_CLOUD_TOKEN is not configured")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token.strip(), API_TOKEN):
        raise HTTPException(status_code=401, detail="invalid token", headers={"WWW-Authenticate": "Bearer"})


class Event(BaseModel):
    client_id: str = Field(default="desktop")
    created_at: str | None = None
    app_name: str = ""
    window_title: str = ""
    kind: str = "manual"
    note: str = ""
    file_path: str = ""
    screenshot_path: str = ""
    duration_seconds: int = 0
    status: str = "pending"
    value_score: int = 0
    summary: str = ""
    category: str = "个人成长"
    source: str = "desktop"


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, created_at TEXT NOT NULL,
        payload TEXT NOT NULL)""")
    return conn


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "sydney-cloud-sync"}


@app.post("/events", dependencies=[Depends(require_token)])
def create_event(event: Event) -> dict[str, Any]:
    payload = event.model_dump()
    payload["created_at"] = payload["created_at"] or datetime.now(timezone.utc).isoformat()
    with closing(connection()) as conn, conn:
        cursor = conn.execute("INSERT INTO events(client_id, created_at, payload) VALUES (?, ?, ?)", (event.client_id, payload["created_at"], json.dumps(payload, ensure_ascii=False)))
        return {"id": cursor.lastrowid, "created_at": payload["created_at"]}


@app.post("/sync", dependencies=[Depends(require_token)])
def sync_events(events: list[Event]) -> dict[str, int]:
    for event in events:
        create_event(event)
    return {"accepted": len(events)}


@app.get("/events", dependencies=[Depends(require_token)])
def list_events(client_id: str = "desktop", limit: int = 100) -> list[dict[str, Any]]:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 500")
    with closing(connection()) as conn:
        rows = conn.execute("SELECT payload FROM events WHERE client_id = ? ORDER BY id DESC LIMIT ?", (client_id, limit)).fetchall()
    return [json.loads(row["payload"]) for row in rows]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("SYDNEY_CLOUD_HOST", "127.0.0.1"), port=int(os.environ.get("SYDNEY_CLOUD_PORT", "8000")))
