"""Sydney optional sync API. The desktop app remains usable without this service."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


DATA_DIR = Path(os.environ.get("SYDNEY_CLOUD_DATA", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "sydney-cloud.db"
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Sydney Cloud Sync", version="0.1.0")


class Event(BaseModel):
    """A single work event uploaded by the desktop client.

    ``local_id`` is the row id in the desktop's own SQLite database; combined with
    ``client_id`` it forms the dedup key. ``file_path`` is kept for backward
    compatibility with older clients; the desktop now sends ``related_path``.
    """

    client_id: str = Field(default="desktop")
    local_id: int = 0
    created_at: str | None = None
    app_name: str = ""
    window_title: str = ""
    kind: str = "manual"
    note: str = ""
    file_path: str = ""
    related_path: str = ""
    adapter: str = ""
    change_type: str = ""
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
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(events)")}
    if "local_id" not in columns:
        conn.execute("ALTER TABLE events ADD COLUMN local_id INTEGER NOT NULL DEFAULT 0")
    # 去重键：同一台客户端的同一条本地记录只存一份；local_id 为 0 的旧数据不受唯一约束影响。
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_local ON events(client_id, local_id) WHERE local_id > 0")
    return conn


@contextmanager
def session():
    """提交后关闭连接，避免长驻进程泄漏句柄、也避免 Windows 上测试删库时文件被锁。"""
    conn = connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _upsert_event(conn: sqlite3.Connection, event: Event) -> tuple[int, bool]:
    payload = event.model_dump()
    created_at = payload["created_at"] or datetime.now(timezone.utc).isoformat()
    payload["created_at"] = created_at
    payload_json = json.dumps(payload, ensure_ascii=False)
    if event.local_id and event.local_id > 0:
        existing = conn.execute(
            "SELECT id FROM events WHERE client_id = ? AND local_id = ?",
            (event.client_id, event.local_id),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE events SET payload = ?, created_at = ? WHERE id = ?",
                (payload_json, created_at, existing["id"]),
            )
            return existing["id"], False
    cursor = conn.execute(
        "INSERT INTO events(client_id, local_id, created_at, payload) VALUES (?, ?, ?, ?)",
        (event.client_id, event.local_id, created_at, payload_json),
    )
    return cursor.lastrowid, True


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "sydney-cloud-sync"}


@app.post("/events")
def create_event(event: Event) -> dict[str, Any]:
    with session() as conn:
        event_id, _created = _upsert_event(conn, event)
        return {"id": event_id}


@app.post("/sync")
def sync_events(events: list[Event]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    with session() as conn:
        for event in events:
            try:
                event_id, created = _upsert_event(conn, event)
                results.append({"local_id": event.local_id, "ok": True, "id": event_id, "created": created})
            except Exception as exc:  # noqa: BLE001 - report per-item failures, keep the rest
                results.append({"local_id": event.local_id, "ok": False, "error": str(exc)})
    accepted = sum(1 for item in results if item["ok"])
    return {"results": results, "accepted": accepted, "failed": len(results) - accepted}


@app.delete("/events")
def delete_event(client_id: str, local_id: int) -> dict[str, Any]:
    with session() as conn:
        cursor = conn.execute("DELETE FROM events WHERE client_id = ? AND local_id = ?", (client_id, local_id))
        return {"deleted": cursor.rowcount}


@app.get("/events")
def list_events(client_id: str = "desktop", limit: int = 100) -> list[dict[str, Any]]:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 500")
    with session() as conn:
        rows = conn.execute("SELECT payload FROM events WHERE client_id = ? ORDER BY id DESC LIMIT ?", (client_id, limit)).fetchall()
    return [json.loads(row["payload"]) for row in rows]
