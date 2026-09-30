import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))

import evolve


class EvolutionEngineTests(unittest.TestCase):
    def test_fingerprint_changes_when_input_note_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / "01-输入").mkdir()
            note = vault / "01-输入" / "学习.md"
            note.write_text("# 初始\n", encoding="utf-8")
            config = {"exclude_dirs": [".obsidian", "00-系统", "02-每日总结", "03-进化记录", "scripts"]}

            first = evolve.fingerprint_inputs(vault, config)
            note.write_text("# 更新\n", encoding="utf-8")
            second = evolve.fingerprint_inputs(vault, config)

            self.assertNotEqual(first, second)

    def test_upsert_preserves_manual_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "summary.md"
            path.write_text(
                "# 总结\n\n我的判断\n\n"
                + evolve.START_MARKER
                + "\n旧内容\n"
                + evolve.END_MARKER
                + "\n",
                encoding="utf-8",
            )
            evolve.upsert_generated(path, "新内容")
            content = path.read_text(encoding="utf-8")
            self.assertIn("我的判断", content)
            self.assertIn("新内容", content)
            self.assertNotIn("旧内容", content)

    def test_fingerprint_ignores_system_and_generated_notes(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / "01-输入").mkdir()
            (vault / "00-系统").mkdir()
            (vault / "02-每日总结").mkdir()
            (vault / "01-输入" / "学习.md").write_text("学习", encoding="utf-8")
            system_note = vault / "00-系统" / "原则.md"
            generated_note = vault / "02-每日总结" / "今天.md"
            system_note.write_text("系统", encoding="utf-8")
            generated_note.write_text("总结", encoding="utf-8")
            config = {"exclude_dirs": [".obsidian", "00-系统", "02-每日总结", "03-进化记录", "scripts"]}

            first = evolve.fingerprint_inputs(vault, config)
            system_note.write_text("系统更新", encoding="utf-8")
            generated_note.write_text("总结更新", encoding="utf-8")

            self.assertEqual(first, evolve.fingerprint_inputs(vault, config))


if __name__ == "__main__":
    unittest.main()
