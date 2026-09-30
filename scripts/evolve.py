#!/usr/bin/env python3
"""Sydney local-first Obsidian self-summary and evolution engine."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib import error, request


START_MARKER = "<!-- SYDNEY:GENERATED:START -->"
END_MARKER = "<!-- SYDNEY:GENERATED:END -->"
DEFAULT_EXCLUDES = {".obsidian", "00-系统", "02-每日总结", "03-进化记录", "scripts"}
TERM_STOPWORDS = {
    "今天", "然后", "因为", "所以", "但是", "这个", "那个", "一个", "进行", "使用", "可以",
    "需要", "通过", "目前", "自己", "内容", "问题", "以及", "如果", "已经", "开始", "完成",
}


@dataclass
class Note:
    path: Path
    relative: str
    title: str
    text: str
    modified: datetime
    tags: list[str]
    headings: list[str]
    actions: list[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="总结 Obsidian 笔记并生成 Sydney 进化候选")
    parser.add_argument("--vault", default=".", help="Obsidian vault 路径")
    parser.add_argument("--date", default=date.today().isoformat(), help="目标日期，格式 YYYY-MM-DD")
    parser.add_argument("--days", type=int, default=1, help="向前读取多少天内修改的笔记")
    parser.add_argument("--ai", action="store_true", help="显式启用 OpenAI 兼容接口")
    parser.add_argument("--dry-run", action="store_true", help="只显示结果，不写入文件")
    parser.add_argument("--watch", action="store_true", help="持续观察输入笔记变化")
    parser.add_argument("--interval", type=float, default=30, help="观察间隔秒数，默认 30")
    return parser.parse_args()


def load_config(vault: Path) -> dict[str, Any]:
    config_path = vault / "00-系统" / "config.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"配置文件格式错误: {config_path}: {exc}") from exc


def in_window(timestamp: datetime, target: date, days: int) -> bool:
    start = target - timedelta(days=max(1, days) - 1)
    return start <= timestamp.date() <= target


def extract_title(text: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", text, flags=re.MULTILINE)
    return match.group(1).strip() if match else fallback


def read_notes(vault: Path, target: date, days: int, config: dict[str, Any]) -> list[Note]:
    excludes = set(config.get("exclude_dirs", DEFAULT_EXCLUDES))
    max_chars = int(config.get("max_note_chars", 12000))
    notes: list[Note] = []
    for path in vault.rglob("*.md"):
        relative_path = path.relative_to(vault)
        if any(part in excludes for part in relative_path.parts):
            continue
        try:
            modified = datetime.fromtimestamp(path.stat().st_mtime)
        except OSError:
            continue
        if not in_window(modified, target, days):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        clipped = text[:max_chars]
        tags = sorted(set(re.findall(r"(?<![\w#])#([\w\-/\u4e00-\u9fff]+)", clipped)))
        headings = [item.strip() for item in re.findall(r"^#{1,6}\s+(.+?)\s*$", clipped, re.MULTILINE)]
        actions = [
            item.strip()
            for item in re.findall(r"^-\s+\[[ xX]\]\s+(.+?)\s*$", clipped, re.MULTILINE)
        ]
        notes.append(
            Note(
                path=path,
                relative=str(relative_path).replace("\\", "/"),
                title=extract_title(clipped, path.stem),
                text=clipped,
                modified=modified,
                tags=tags,
                headings=headings,
                actions=actions,
            )
        )
    return sorted(notes, key=lambda item: item.modified)


def fingerprint_inputs(vault: Path, config: dict[str, Any]) -> str:
    """Return a stable fingerprint for notes eligible for automatic observation."""
    excludes = set(config.get("exclude_dirs", DEFAULT_EXCLUDES))
    input_dirs = [vault / item for item in config.get("input_dirs", ["01-输入"])]
    if config.get("include_root_notes", True):
        input_dirs.append(vault)
    rows: list[str] = []
    seen: set[Path] = set()
    for root in input_dirs:
        if not root.exists():
            continue
        candidates = [root] if root.is_file() else root.rglob("*.md")
        for path in candidates:
            if path in seen or path.suffix.lower() != ".md":
                continue
            seen.add(path)
            relative = path.relative_to(vault)
            if any(part in excludes for part in relative.parts):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            rows.append(f"{relative.as_posix()}:{stat.st_size}:{stat.st_mtime_ns}")
    import hashlib
    return hashlib.sha256("\n".join(sorted(rows)).encode("utf-8")).hexdigest()


def extract_signal_lines(notes: list[Note]) -> list[str]:
    signals: list[str] = []
    keywords = ("经验", "结论", "解决", "问题", "下一步", "待办", "复盘", "学到", "方法", "TODO", "优化")
    for note in notes:
        for line in note.text.splitlines():
            clean = re.sub(r"^\s*[-*>#`]+\s*", "", line).strip()
            if clean and any(keyword.lower() in clean.lower() for keyword in keywords):
                signals.append(f"{clean[:180]}（来源：{note.relative}）")
    return list(dict.fromkeys(signals))[:20]


def frequent_terms(notes: list[Note]) -> list[str]:
    terms: Counter[str] = Counter()
    for note in notes:
        for tag in note.tags:
            terms[f"#{tag}"] += 2
        for heading in note.headings:
            for term in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}", heading):
                if term not in TERM_STOPWORDS:
                    terms[term] += 1
    return [term for term, _ in terms.most_common(12)]


def local_summary(notes: list[Note], target: date) -> tuple[str, str]:
    sources = "\n".join(f"- [[{note.relative[:-3]}]]（{note.modified:%H:%M}，{len(note.text)} 字）" for note in notes)
    sources = sources or "- 今日没有检测到新增或修改的输入笔记。"
    topics = frequent_terms(notes)
    topic_text = "、".join(topics) if topics else "暂无足够主题信号"
    actions = []
    for note in notes:
        actions.extend(f"{action}（来源：{note.relative}）" for action in note.actions)
    action_text = "\n".join(f"- {item}" for item in dict.fromkeys(actions) if item) or "- 暂无明确行动项，请在‘我的补充’中填写。"
    signals = extract_signal_lines(notes)
    signal_text = "\n".join(f"- {item}" for item in signals) or "- 暂无可识别的经验或问题线索。"
    generated = f"""## 自动总结

### 今日输入
{sources}

### 主题信号
{topic_text}

### 行动与任务
{action_text}

### 值得保留的经验线索
{signal_text}

### 下一步
- [ ] 人工确认今天最重要的一条结论。
- [ ] 将已验证的方法写入 `04-工作流`，或明确标记为待验证。

### 来源与边界
- 扫描窗口：{target.isoformat()}
- 处理方式：本地规则总结（未上传原始笔记）
- 来源数量：{len(notes)}
"""

    unchecked = [action for note in notes for action in note.actions]
    evolution_items = []
    if unchecked:
        evolution_items.append("把重复出现的待办整理为一个可复用工作流：" + "；".join(dict.fromkeys(unchecked[:5])))
    if topics:
        evolution_items.append(f"围绕高频主题 `{topics[0]}` 建立一页方法论，并记录一个可验证的例子。")
    if signals:
        evolution_items.append("从今天的经验线索中选择一条，补充‘适用场景、步骤、失败边界’后再沉淀。")
    if not notes:
        evolution_items.append("先记录一条学习或工作输入，再运行总结；没有原始输入时不生成未经证实的结论。")
    evolution = "\n".join(f"- [ ] {item}" for item in evolution_items)
    evolution_generated = f"""## 进化候选

以下内容只是候选，确认后再修改正式工作流：

{evolution}

## 需要验证

- [ ] 这个候选是否在不同任务中重复出现？
- [ ] 是否能用明确结果判断它有效？
- [ ] 是否涉及个人偏好、隐私或不可泛化的偶然经验？

## 依据

- 主题信号：{topic_text}
- 关联输入：{len(notes)} 篇
- 生成方式：本地规则总结（未上传原始笔记）
"""
    return generated, evolution_generated


def load_history(vault: Path, config: dict[str, Any]) -> str:
    directory = vault / config.get("evolution_dir", "03-进化记录")
    if not directory.exists():
        return ""
    files = sorted(directory.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True)[:5]
    return "\n\n".join(item.read_text(encoding="utf-8")[:5000] for item in files)


def call_llm(notes: list[Note], history: str, target: date, config: dict[str, Any]) -> tuple[str, str]:
    base_url = os.environ.get("SYDNEY_LLM_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("SYDNEY_LLM_API_KEY", "")
    model = os.environ.get("SYDNEY_LLM_MODEL", "")
    if not base_url or not api_key or not model:
        raise RuntimeError("--ai 需要设置 SYDNEY_LLM_BASE_URL、SYDNEY_LLM_API_KEY 和 SYDNEY_LLM_MODEL")
    max_context = int(config.get("max_context_chars", 50000))
    note_context = "\n\n".join(f"## {note.relative}\n{note.text}" for note in notes)
    user_prompt = f"""目标日期：{target.isoformat()}
请根据以下 Obsidian 笔记和历史进化记录，输出严格 JSON：
{{"summary_markdown":"每日总结的 Markdown", "evolution_markdown":"进化候选的 Markdown"}}
要求：只陈述来源支持的事实；区分事实、推断和待验证项；不要执行外部操作；保留来源路径。

当前笔记：
{note_context[:max_context]}

历史进化记录：
{history[:8000]}
"""
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "你是 Sydney，一个服务个人成长的本地知识库总结助手。"},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=90) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"AI 请求失败：{exc}") from exc
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    content = re.sub(r"^```json\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
    try:
        result = json.loads(content)
        return str(result["summary_markdown"]), str(result["evolution_markdown"])
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise RuntimeError(f"AI 返回的 JSON 不符合约定：{exc}") from exc


def upsert_generated(path: Path, generated: str) -> None:
    if path.exists():
        current = path.read_text(encoding="utf-8")
        pattern = re.compile(re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER), re.DOTALL)
        block = f"{START_MARKER}\n{generated.rstrip()}\n{END_MARKER}"
        if pattern.search(current):
            path.write_text(pattern.sub(block, current, count=1), encoding="utf-8")
        else:
            path.write_text(current.rstrip() + f"\n\n{block}\n", encoding="utf-8")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\ntype: sydney-generated\nstatus: review\n---\n\n# {path.stem}\n\n{START_MARKER}\n{generated.rstrip()}\n{END_MARKER}\n",
        encoding="utf-8",
    )


def run_once(args: argparse.Namespace, vault: Path, target: date, config: dict[str, Any]) -> int:
    notes = read_notes(vault, target, args.days, config)
    summary, evolution = local_summary(notes, target)
    mode = "local"
    if args.ai:
        try:
            summary, evolution = call_llm(notes, load_history(vault, config), target, config)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        mode = "ai"
    summary_path = vault / config.get("summary_dir", "02-每日总结") / f"{target.isoformat()}.md"
    evolution_path = vault / config.get("evolution_dir", "03-进化记录") / f"{target.isoformat()}-进化.md"
    if args.dry_run:
        print(f"模式：{mode}；输入笔记：{len(notes)} 篇")
        print(f"\n=== {summary_path} ===\n{summary}")
        print(f"\n=== {evolution_path} ===\n{evolution}")
        return 0
    upsert_generated(summary_path, summary)
    upsert_generated(evolution_path, evolution)
    print(f"已生成：{summary_path}")
    print(f"已生成：{evolution_path}")
    print(f"模式：{mode}；输入笔记：{len(notes)} 篇")
    return 0


def watch(vault: Path, config: dict[str, Any], args: argparse.Namespace) -> int:
    """Poll for input changes and summarize once per change."""
    previous = ""
    print(f"开始观察 {vault}，间隔 {args.interval:g} 秒；按 Ctrl+C 停止。")
    try:
        while True:
            current = fingerprint_inputs(vault, config)
            if current != previous:
                previous = current
                target = date.today()
                result = run_once(args, vault, target, config)
                if result != 0:
                    return result
            time.sleep(max(1.0, args.interval))
    except KeyboardInterrupt:
        print("已停止观察。")
        return 0


def main() -> int:
    args = parse_args()
    vault = Path(args.vault).expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        print(f"知识库目录不存在：{vault}", file=sys.stderr)
        return 2
    config = load_config(vault)
    if args.watch:
        return watch(vault, config, args)
    try:
        target = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        print("--date 必须是 YYYY-MM-DD", file=sys.stderr)
        return 2
    return run_once(args, vault, target, config)


if __name__ == "__main__":
    raise SystemExit(main())
