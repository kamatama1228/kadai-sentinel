"""Discord Webhook への投稿。"""

from __future__ import annotations

import time
import zlib
from dataclasses import dataclass, field
from typing import Any

import requests

PALETTE = [0x5865F2, 0x57F287, 0xFEE75C, 0xEB459E, 0xED4245, 0x3BA55C,
           0xFAA61A, 0x9B59B6, 0x1ABC9C, 0xE67E22, 0x3498DB, 0x95A5A6]


def course_color(course_id: int) -> int:
    return PALETTE[zlib.crc32(str(course_id).encode()) % len(PALETTE)]


@dataclass
class Notice:
    heading: str                 # 例 "🚨 小テスト公開中"
    course_id: int
    course: str
    title: str
    url: str = ""
    fields: list[tuple[str, str]] = field(default_factory=list)
    urgent: bool = False         # 公開中の小テストなど。まとめずに必ず単独で送る

    def embed(self) -> dict[str, Any]:
        e: dict[str, Any] = {
            "author": {"name": self.heading},
            "title": self.title[:256],
            "color": 0xED4245 if self.urgent else course_color(self.course_id),
            "fields": [{"name": "授業", "value": self.course[:1024] or "-", "inline": False}]
                      + [{"name": k, "value": v[:1024], "inline": True} for k, v in self.fields],
        }
        if self.url.startswith("http"):
            e["url"] = self.url
        return e

    def line(self) -> str:
        title = f"[{self.title[:60]}]({self.url})" if self.url.startswith("http") else self.title[:60]
        detail = "・".join(v for _, v in self.fields)
        return f"{self.heading} **{self.course[:30]}**\n　{title}({detail})"


def digest(notices: list[Notice], title: str) -> dict[str, Any]:
    return {"title": title, "description": "\n".join(n.line() for n in notices)[:4000],
            "color": 0x5865F2}


def send(webhook_url: str, notices: list[Notice], digest_title: str = "Moodle 更新") -> None:
    """急ぎのものは単独で、それ以外は3件までは個別・4件以上は1つにまとめて送る。"""
    urgent = [n for n in notices if n.urgent]
    normal = [n for n in notices if not n.urgent]
    for n in urgent:
        post(webhook_url, [n.embed()])
    if normal:
        post(webhook_url, [n.embed() for n in normal] if len(normal) <= 3
             else [digest(normal, f"{digest_title} {len(normal)} 件")])


def post(webhook_url: str, embeds: list[dict[str, Any]], content: str | None = None) -> None:
    for i in range(0, max(len(embeds), 1), 10):
        payload: dict[str, Any] = {"embeds": embeds[i:i + 10], "allowed_mentions": {"parse": []}}
        if content and i == 0:
            payload["content"] = content
        for _ in range(5):
            r = requests.post(webhook_url, json=payload, timeout=30)
            if r.status_code == 429:
                time.sleep(float(r.json().get("retry_after", 1)) + 0.5)
                continue
            r.raise_for_status()
            break
        time.sleep(0.5)
