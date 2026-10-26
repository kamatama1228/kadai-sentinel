"""`uv run moodle config ...` 設定ファイル(config/)を扱うコマンド。人でも AI でも同じ手順で使える。

  config check              設定を検査する(書き間違い・知らない項目・値の誤り)
  config show [授業]         授業ごとに、今どう通知されるかを日本語で表示する
  config add-course 授業ID   config/courses/授業ID.json を作る(授業名は Moodle から取る)
  config migrate            notify.toml を config/ の JSON に変換する(元のファイルは state/ に残す)

設定を解釈するコードは Cloudflare 版と同じもの(worker/)を使う(実装を1か所にするため)。
そのため check / show / migrate は Node.js(22.6 以上)で動かす。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG_CLI = ROOT / "worker" / "scripts" / "config-cli.mjs"
MIN_NODE = (22, 6)


def node_command() -> list[str] | None:
    """config-cli.mjs を動かすコマンド。Node.js がない・古いときは None"""
    node = shutil.which("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v(\d+)\.(\d+)", out)
    if not m or (int(m[1]), int(m[2])) < MIN_NODE:
        return None
    flags = [] if (int(m[1]), int(m[2])) >= (23, 6) else ["--experimental-strip-types"]
    return [node, *flags, "--no-warnings", str(CONFIG_CLI)]


def run_node(*args: str) -> int:
    cmd = node_command()
    if cmd is None:
        print("このコマンドには Node.js 22.6 以上が必要です(Cloudflare 版を動かすのにも使います)。\n"
              "入れ方: winget install -e --id OpenJS.NodeJS.LTS(入れたらターミナルを開き直す)", file=sys.stderr)
        return 1
    if not (ROOT / "worker" / "node_modules").exists():
        print("先に worker フォルダで npm install を1回実行してください。", file=sys.stderr)
        return 1
    return subprocess.run([*cmd, *args], cwd=ROOT).returncode


def cmd_check(args: argparse.Namespace) -> int:
    return run_node("check")


def cmd_show(args: argparse.Namespace) -> int:
    return run_node("show", *([args.query] if args.query else []))


def cmd_migrate(args: argparse.Namespace) -> int:
    return run_node("migrate", *(["--dry-run"] if args.dry_run else []))


def cmd_add_course(args: argparse.Namespace) -> int:
    path = ROOT / "config" / "courses" / f"{args.course_id}.json"
    if path.exists():
        print(f"{path.relative_to(ROOT).as_posix()} はもうあります。そのファイルを書き換えてください。", file=sys.stderr)
        return 1
    name = args.name or ""
    if not name:
        try:
            from cli.main import _client_or_exit
            from core.materials import list_courses
            from core.tasks import _clean
            name = next((_clean(c["fullname"]) for c in list_courses(_client_or_exit()) if c["id"] == args.course_id), "")
        except SystemExit:
            name = ""
        except Exception as e:
            print(f"授業名を Moodle から取れませんでした({e})。--name で指定できます。", file=sys.stderr)
    body: dict[str, Any] = {"$schema": "../../schema/course.schema.json", "id": args.course_id, "name": name,
                            "personal": {"notify": True}}
    if args.shared:
        body["shared"] = {"enabled": True, "events": ["new", "scheduled", "open", "due_changed"], "remind": ["1d"]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"作りました: {path.relative_to(ROOT).as_posix()}({name or '授業名なし'})")
    print("書ける項目は docs/CUSTOMIZE.md。書いたら uv run moodle config check")
    return 0


def register(sub: Any) -> None:
    p = sub.add_parser("config", help="設定ファイル(config/)の検査・表示・作成")
    cs = p.add_subparsers(dest="config_command", required=True)
    cs.add_parser("check", help="設定を検査する").set_defaults(func=cmd_check)
    ps = cs.add_parser("show", help="授業ごとに、今どう通知されるかを表示する")
    ps.add_argument("query", nargs="?", help="授業ID か 授業名の一部")
    ps.set_defaults(func=cmd_show)
    pa = cs.add_parser("add-course", help="config/courses/授業ID.json を作る")
    pa.add_argument("course_id", type=int)
    pa.add_argument("--name", help="授業名(省略時は Moodle から取る)")
    pa.add_argument("--shared", action="store_true", help="共有チャンネルに流す設定も入れる")
    pa.set_defaults(func=cmd_add_course)
    pm = cs.add_parser("migrate", help="notify.toml を config/ の JSON に変換する")
    pm.add_argument("--dry-run", action="store_true", help="変換結果を表示するだけ")
    pm.set_defaults(func=cmd_migrate)
