"""手元での確認用 CLI。

  uv run moodle login          ユーザー名・パスワードでトークンを取得して .env に保存
  uv run moodle login --manual トークンを手で貼り付けて保存(SSO の大学向け)
  uv run moodle login --sso    ブラウザで SSO ログインしてトークンを取得(SSO の大学向け)
  uv run moodle diagnose       大学の Moodle のログイン方式を調べる
  uv run moodle check          保存したトークンで接続確認
  uv run moodle tasks          やること一覧(未提出の課題・小テスト)を表示
  uv run moodle courses        履修中の授業一覧
  uv run moodle files          配布資料を materials/ にダウンロード(更新分のみ)
  uv run moodle notify         1回だけ確認して Discord に通知
  uv run moodle watch          常駐して通知を続ける
  uv run moodle assign 名前    課題の設定と自分の提出状況を表示
"""

from __future__ import annotations

import argparse
from pathlib import Path
import json
import getpass
import secrets
import sys

from core.config import ENV_PATH, load_env, save_env
from core.moodle import (DEFAULT_SERVICE, MoodleClient, MoodleError, get_token,
                         parse_sso_token, public_config, sso_launch_url)

# 設計ドキュメントで使う予定の関数。トークンで呼べるかを接続確認時にチェックする。
PLANNED_FUNCTIONS = [
    "core_webservice_get_site_info",
    "core_calendar_get_action_events_by_timesort",
    "mod_assign_get_assignments",
    "mod_forum_get_forum_discussions",
]

SSO_HINT = """
ユーザー名・パスワードでのトークン取得に失敗しました。
大学が SSO(学認・Shibboleth・Microsoft など)でログインしている場合はこの方法が使えません。
その場合は次を試してください:
  uv run moodle login --sso   (ブラウザで大学のログイン画面を使ってトークンを取得)
ユーザー名の形式(学籍番号かメールアドレスか)が違うだけの可能性もあります。
"""


SSO_STEPS = """
次の URL を Chrome か Edge で開き、いつもの大学のログイン画面でログインしてください:

  {url}

【先に】ブラウザで F12 → 「ネットワーク(Network)」タブを開き、
        「ログを保持(Preserve log)」にチェックを入れてから URL を開きます。

ログイン後、ネットワークの一覧で名前が launch.php の行をクリック →
「ヘッダー(Headers)」の Response Headers にある
  location: moodlemobile://token=....
の moodlemobile://token=... 以降を最後(== など)まで全部コピーしてください。
(Console タブに Failed to launch 'moodlemobile://token=...' と出ている場合はそれでも OK)
これはあなた専用のトークンです。人に見せたりチャットに貼ったりしないでください。
"""

def _clipboard() -> str:
    """Windows ならクリップボードを直接読む(PowerShell への貼り付けで文字が欠けるのを防ぐ)。"""
    import subprocess
    if sys.platform != "win32":
        return ""
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
                             capture_output=True, text=True, encoding="utf-8", timeout=10)
        return out.stdout
    except Exception:
        return ""


def _read_sso_result() -> str:
    if sys.platform == "win32":
        input("moodlemobile://token=... をコピーしたら Enter を押してください(クリップボードから読み取ります): ")
        text = "".join(_clipboard().split())
        if "token=" in text:
            return text
        print("クリップボードに moodlemobile://token=... が見つかりませんでした。")
    text = input("ここに貼り付けて Enter: ")
    return "".join(text.split())


LOGIN_TYPES = {1: "アプリ内でユーザー名・パスワード", 2: "ブラウザ(SSO)", 3: "アプリ内ブラウザ(SSO)"}


def cmd_diagnose(args: argparse.Namespace) -> int:
    url = _ask_url(load_env())
    try:
        cfg = public_config(url)
    except Exception as e:
        print(f"公開設定を取得できませんでした: {e}", file=sys.stderr)
        print("モバイルアプリ用のサービスが無効になっている可能性があります。", file=sys.stderr)
        return 1
    print(f"サイト名        : {cfg.get('sitename')}")
    print(f"Moodle          : {cfg.get('release')}")
    print(f"アプリのログイン: {LOGIN_TYPES.get(cfg.get('typeoflogin'), cfg.get('typeoflogin'))}")
    if cfg.get("identityproviders"):
        print("外部ログイン    : " + ", ".join(p.get("name", "?") for p in cfg["identityproviders"]))
    if cfg.get("typeoflogin") in (2, 3):
        print("\n→ SSO なので uv run moodle login --sso を使ってください。")
    else:
        print("\n→ ユーザー名・パスワード方式です。ユーザー名の形式を確認して uv run moodle login を再実行してください。")
    return 0


def _ask_url(env: dict[str, str]) -> str:
    current = env.get("MOODLE_URL", "")
    prompt = f"Moodle の URL [{current}]: " if current else "Moodle の URL (例: https://moodle.example.ac.jp): "
    url = input(prompt).strip() or current
    if not url:
        sys.exit("URL が入力されていません。")
    return url


def cmd_login(args: argparse.Namespace) -> int:
    env = load_env()
    url = _ask_url(env)
    service = env.get("MOODLE_SERVICE", DEFAULT_SERVICE)

    if args.manual:
        token = getpass.getpass("トークン(入力は表示されません): ").strip()
    elif args.sso:
        passport = secrets.token_hex(8)
        print(SSO_STEPS.format(url=sso_launch_url(url, passport, service)))
        pasted = _read_sso_result()
        try:
            token = parse_sso_token(pasted, url, passport)
        except MoodleError as e:
            if e.errorcode != "badssosignature":
                print(f"エラー: {e}", file=sys.stderr)
                return 1
            # 前回表示した URL でログインした場合など。トークン自体は接続確認で検証する
            print("注意: 今回の URL とは別のログインで取得した文字列のようです。そのまま接続確認します。")
            token = parse_sso_token(pasted)
    else:
        username = input("ユーザー名: ").strip()
        password = getpass.getpass("パスワード(入力は表示されません。保存もしません): ")
        try:
            token = get_token(url, username, password, service)
        except MoodleError as e:
            print(f"エラー: {e} ({e.errorcode})", file=sys.stderr)
            if e.errorcode in {"invalidlogin", "enablewsdescription", "servicenotavailable",
                               "sitemaintenance", None}:
                print(SSO_HINT, file=sys.stderr)
            return 1
        except Exception as e:  # 通信エラーなど
            print(f"接続に失敗しました: {e}", file=sys.stderr)
            return 1
        finally:
            password = ""  # noqa: F841  念のため参照を消す

    if not token:
        print("トークンが空です。", file=sys.stderr)
        return 1

    # 保存前に本当に使えるトークンか確かめる
    if check(url, token) != 0:
        print("このトークンでは接続できなかったので保存しませんでした。", file=sys.stderr)
        return 1
    save_env({"MOODLE_URL": url, "MOODLE_TOKEN": token})
    print(f"\n{ENV_PATH} に保存しました。このファイルは Git に含めないでください。")
    return 0


def check(url: str, token: str) -> int:
    client = MoodleClient(url, token)
    try:
        info = client.site_info()
    except MoodleError as e:
        print(f"接続確認に失敗しました: {e} ({e.errorcode})", file=sys.stderr)
        if e.errorcode == "invalidtoken":
            print("トークンが無効か期限切れです。uv run moodle login で取り直してください。", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"接続に失敗しました: {e}", file=sys.stderr)
        return 1

    print("接続できました")
    print(f"  サイト   : {info.get('sitename')}")
    print(f"  ユーザー : {info.get('fullname')} (id={info.get('userid')})")
    print(f"  Moodle   : {info.get('release')}")

    available = {f["name"] for f in info.get("functions", [])}
    if available:
        print("  使う予定の API:")
        for name in PLANNED_FUNCTIONS:
            mark = "OK" if name in available else "NG"
            print(f"    [{mark}] {name}")
    return 0


def _client_or_exit() -> MoodleClient:
    env = load_env()
    if not env.get("MOODLE_URL") or not env.get("MOODLE_TOKEN"):
        sys.exit("MOODLE_URL と MOODLE_TOKEN が未設定です。先に uv run moodle login を実行してください。")
    return MoodleClient(env["MOODLE_URL"], env["MOODLE_TOKEN"])


def cmd_tasks(args: argparse.Namespace) -> int:
    from core.tasks import fetch_todo
    try:
        tasks = fetch_todo(_client_or_exit(), days_ahead=args.days, days_back=args.back)
    except MoodleError as e:
        print(f"取得に失敗しました: {e} ({e.errorcode})", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps([t.to_dict() for t in tasks], ensure_ascii=False, indent=2))
        return 0
    if not tasks:
        print(f"今後 {args.days} 日のやることはありません。")
        return 0
    for t in tasks:
        mark = "!!" if t.status == "期限切れ" else "  "
        print(f"{mark}{t.due_text}  [{t.type}] {t.course} / {t.title}")
        if args.url:
            print(f"      {t.url}")
    print(f"\n{len(tasks)} 件(!! は締切を過ぎたもの)")
    return 0


def cmd_courses(args: argparse.Namespace) -> int:
    from core.materials import list_courses
    from core.tasks import _clean
    for c in list_courses(_client_or_exit()):
        print(f"{c['id']:>6}  {_clean(c['fullname'])}")
    return 0


def cmd_files(args: argparse.Namespace) -> int:
    from core.materials import MATERIALS_DIR, sync
    res = sync(_client_or_exit(), args.course, dry_run=args.dry_run)
    n, u, s = (len(res[k]) for k in ("new", "updated", "skipped"))
    if args.dry_run:
        for p in res["new"] + res["updated"]:
            print(f"  {p}")
        print(f"取得予定: 新着 {n} / 更新 {u}(--dry-run のため未取得)")
    else:
        print(f"完了: 新着 {n} / 更新 {u} / スキップ {s}  → {MATERIALS_DIR.resolve()}")
    return 0


def _env_or_exit() -> dict[str, str]:
    env = load_env()
    if not env.get("MOODLE_URL") or not env.get("MOODLE_TOKEN"):
        sys.exit("MOODLE_URL と MOODLE_TOKEN が未設定です。")
    return env


def cmd_notify(args: argparse.Namespace) -> int:
    env = _env_or_exit()
    if args.test:
        from core.activities import fmt_time
        from notifier.discord import Notice, send
        url = env.get("PERSONAL_WEBHOOK_URL" if args.test == "personal" else "DISCORD_WEBHOOK_URL")
        if not url:
            sys.exit("Webhook の URL が .env に設定されていません。")
        send(url, [Notice("🧪 kadai-sentinel のテスト投稿です", 0, "(テスト)授業名",
                          "(テスト)第3回授業小テスト", env["MOODLE_URL"],
                          [("受付", "10/15(木) 14:35〜14:44"), ("残り", "あと 9 分")], urgent=True)])
        print("テスト投稿を送りました。Discord を確認してください。")
        return 0
    from notifier.run import run_once
    run_once(env, dry_run=args.dry_run, init=args.init)
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    import logging
    from logging.handlers import RotatingFileHandler
    from pathlib import Path
    from notifier.run import watch
    Path("state").mkdir(exist_ok=True)
    handlers: list[logging.Handler] = [RotatingFileHandler("state/watch.log", maxBytes=1_000_000,
                                                           backupCount=2, encoding="utf-8")]
    if sys.stdout is not None:                     # pythonw で起動したときは画面がない
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)
    watch(_env_or_exit(), log=logging.info)
    return 0


def _pick_assignment(client, query: str):
    from core.assignments import find_assignment
    found = find_assignment(client, query)
    if not found:
        sys.exit(f"「{query}」に当てはまる課題がありません。")
    if len(found) > 1:
        print("複数の課題が当てはまります。課題IDで指定してください:")
        for a in found:
            print(f"  {a.id:>6}  {a.course} / {a.title}")
        sys.exit(1)
    return found[0]


def cmd_assign(args: argparse.Namespace) -> int:
    from core.activities import fmt_time
    from core.assignments import STATUS_LABELS, submission_status
    client = _client_or_exit()
    a = _pick_assignment(client, args.query)
    st = submission_status(client, a)
    print(f"{a.course} / {a.title}(課題ID {a.id})")
    print(f"  締切     : {fmt_time(a.due) if a.due else 'なし'}")
    kinds = [k for k, on in (("ファイル", a.file_enabled), ("オンラインテキスト", a.text_enabled)) if on]
    print(f"  提出方法 : {'・'.join(kinds) or 'Moodle 上で提出しない課題'}"
          + (f"(最大 {a.max_files} 個" + (f"、{a.filetypes}" if a.filetypes else "") + ")" if a.file_enabled else ""))
    print(f"  下書き   : {'あり(下書き → 提出の2段階)' if a.drafts else 'なし(保存した時点で提出済み)'}")
    print(f"  状態     : {STATUS_LABELS.get(st['status'], st['status'])}"
          + ("(編集可)" if st["canedit"] else "") + ("(ロック中)" if st["locked"] else ""))
    for n, size in st["files"]:
        print(f"  提出済み : {n}({size / 1024:.0f} KB)")
    print(f"  リンク   : {a.url}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    env = load_env()
    if not env.get("MOODLE_URL") or not env.get("MOODLE_TOKEN"):
        print("MOODLE_URL と MOODLE_TOKEN が未設定です。先に uv run moodle login を実行してください。",
              file=sys.stderr)
        return 1
    return check(env["MOODLE_URL"], env["MOODLE_TOKEN"])


def main() -> None:
    parser = argparse.ArgumentParser(prog="moodle", description="Moodle 連携ツール")
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", help="トークンを取得して .env に保存")
    p_login.add_argument("--manual", action="store_true",
                         help="セキュリティキー画面のトークンを手で入力する(SSO の大学向け)")
    p_login.add_argument("--sso", action="store_true",
                         help="ブラウザで大学のログイン画面を使ってトークンを取得する")
    p_login.set_defaults(func=cmd_login)

    p_diag = sub.add_parser("diagnose", help="大学の Moodle のログイン方式を調べる")
    p_diag.set_defaults(func=cmd_diagnose)

    p_check = sub.add_parser("check", help="保存したトークンで接続確認")
    p_check.set_defaults(func=cmd_check)

    p_tasks = sub.add_parser("tasks", help="やること一覧を表示")
    p_tasks.add_argument("--days", type=int, default=30, help="何日先まで表示するか(既定 30)")
    p_tasks.add_argument("--back", type=int, default=7, help="何日前の期限切れまで含めるか(既定 7)")
    p_tasks.add_argument("--url", action="store_true", help="Moodle のリンクも表示")
    p_tasks.add_argument("--json", action="store_true", help="Task 形式の JSON で出力")
    p_tasks.set_defaults(func=cmd_tasks)

    p_courses = sub.add_parser("courses", help="履修中の授業一覧")
    p_courses.set_defaults(func=cmd_courses)

    p_files = sub.add_parser("files", help="配布資料をダウンロード(更新分のみ)")
    p_files.add_argument("--course", help="授業IDか授業名の一部(省略時は全授業)")
    p_files.add_argument("--dry-run", action="store_true", help="取得せずに一覧だけ表示")
    p_files.set_defaults(func=cmd_files)

    p_notify = sub.add_parser("notify", help="Discord に差分を通知")
    p_notify.add_argument("--dry-run", action="store_true", help="送信も状態の保存もせずに内容だけ表示")
    p_notify.add_argument("--init", action="store_true", help="現在の一覧を記録するだけで通知しない")
    p_notify.add_argument("--test", nargs="?", const="shared", choices=["shared", "personal"],
                          help="直近の課題1件をサンプルとしてテスト投稿する")
    p_notify.set_defaults(func=cmd_notify)

    p_assign = sub.add_parser("assign", help="課題の設定と提出状況を表示")
    p_assign.add_argument("query", help="課題ID か 名前(授業名を含めてもよい)")
    p_assign.set_defaults(func=cmd_assign)

    p_watch = sub.add_parser("watch", help="常駐して通知を続ける(notify.toml の間隔で確認)")
    p_watch.set_defaults(func=cmd_watch)

    # 追加機能(別配布)があれば、そのコマンドを登録する。
    # インストール済みのパッケージか、このリポジトリの addons/ フォルダに置いたものを探す。
    addons_dir = Path(__file__).resolve().parents[1] / "addons"
    if addons_dir.is_dir() and str(addons_dir) not in sys.path:
        sys.path.append(str(addons_dir))
    try:
        from moodle_tool_addons import register  # type: ignore
    except ImportError:
        register = None
    if register:
        register(sub)

    args = parser.parse_args()
    try:
        sys.exit(args.func(args))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
