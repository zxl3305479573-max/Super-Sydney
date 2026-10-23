"""Server-side sync tests. Run with: python -m unittest cloud_api.test_main"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

# 允许在任意目录下运行：把本文件所在目录加进模块搜索路径。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 必须在导入 main 之前设置：main 在导入时确定数据目录与数据库路径。
_TMP = tempfile.mkdtemp(prefix="sydney-cloud-test-")
os.environ["SYDNEY_CLOUD_DATA"] = _TMP

import main as cloud  # noqa: E402
from main import Event, delete_event, list_events, sync_events  # noqa: E402


class CloudSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        # 每个用例换一个干净的数据库，避免前面用例留下的行污染 list_events。
        for suffix in ("", "-wal", "-shm"):
            path = Path(cloud.DB_PATH)
            candidate = Path(str(path) + suffix)
            if candidate.exists():
                candidate.unlink()

    def _event(self, local_id: int, summary: str = "s", client_id: str = "desktop") -> Event:
        return Event(client_id=client_id, local_id=local_id, summary=summary, category="提效方案", duration_seconds=10)

    def test_same_client_local_is_updated_not_duplicated(self):
        sync_events([self._event(1, "first"), self._event(1, "second")])
        rows = list_events("desktop", 100)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["summary"], "second")

    def test_sync_reports_per_item_results(self):
        result = sync_events([self._event(2, "a"), self._event(3, "b")])
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["failed"], 0)
        self.assertTrue(all(item["ok"] for item in result["results"]))
        self.assertEqual({item["local_id"] for item in result["results"]}, {2, 3})

    def test_delete_by_client_and_local(self):
        sync_events([self._event(4, "x")])
        self.assertEqual(delete_event("desktop", 4)["deleted"], 1)
        self.assertEqual(list_events("desktop", 100), [])

    def test_field_alignment_with_desktop(self):
        event = Event(client_id="desktop", local_id=5, related_path="/p", adapter="fs", change_type="modified")
        sync_events([event])
        row = list_events("desktop", 100)[0]
        self.assertEqual(row["related_path"], "/p")
        self.assertEqual(row["adapter"], "fs")
        self.assertEqual(row["change_type"], "modified")


if __name__ == "__main__":
    unittest.main()
