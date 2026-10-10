"""設定の読み書き。大学固有の値(URL・トークン)は .env と環境変数だけに置く。"""

from __future__ import annotations

import os
from pathlib import Path

ENV_PATH = Path(os.environ.get("MOODLE_ENV_FILE", ".env"))


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    """.env を読み、環境変数で上書きした設定を返す(GitHub Actions では環境変数が優先)。"""
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    for key in ("MOODLE_URL", "MOODLE_TOKEN", "MOODLE_SERVICE", "DISCORD_WEBHOOK_URL",
                "PERSONAL_WEBHOOK_URL", "SHARE_COURSES", "SHARE_TYPES", "MOODLE_TIMEZONE"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def save_env(updates: dict[str, str], path: Path = ENV_PATH) -> None:
    """既存の .env の行を保ったまま、指定したキーだけ書き換える(なければ追記)。"""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    out.extend(f"{k}={v}" for k, v in remaining.items())
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)  # 自分だけが読めるように(Windowsでは無視される)
    except OSError:
        pass
