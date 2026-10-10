"""Moodle Web Services (REST) との通信。CLI・MCP・通知はすべてここを経由する。"""

from __future__ import annotations

from typing import Any

import requests

DEFAULT_SERVICE = "moodle_mobile_app"
TIMEOUT = 30


class MoodleError(Exception):
    """Moodle がエラーを返したとき。errorcode で原因を判別できる。"""

    def __init__(self, message: str, errorcode: str | None = None):
        super().__init__(message)
        self.errorcode = errorcode


def _normalize_url(base_url: str) -> str:
    base_url = base_url.strip().rstrip("/")
    if not base_url.startswith(("https://", "http://")):
        base_url = "https://" + base_url
    return base_url


def get_token(base_url: str, username: str, password: str,
              service: str = DEFAULT_SERVICE) -> str:
    """login/token.php でトークンを取得する。パスワードはこの関数の中でしか使わない。"""
    url = _normalize_url(base_url) + "/login/token.php"
    resp = requests.post(
        url,
        data={"username": username, "password": password, "service": service},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError as e:
        raise MoodleError(
            "Moodle から JSON 以外の応答が返りました。URL が正しいか確認してください。",
            "badresponse",
        ) from e
    if "token" in data:
        return data["token"]
    raise MoodleError(data.get("error", "トークンを取得できませんでした"), data.get("errorcode"))


def public_config(base_url: str) -> dict[str, Any]:
    """ログイン不要の公開設定(ログイン方式やモバイルアプリ対応)を取得する。"""
    url = _normalize_url(base_url) + "/lib/ajax/service-nologin.php"
    resp = requests.post(
        url, json=[{"index": 0, "methodname": "tool_mobile_get_public_config", "args": {}}],
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()[0]
    if data.get("error"):
        raise MoodleError(str(data.get("exception", {}).get("message", "取得できませんでした")),
                          data.get("exception", {}).get("errorcode"))
    return data["data"]


def sso_launch_url(base_url: str, passport: str, service: str = DEFAULT_SERVICE) -> str:
    """モバイルアプリと同じ SSO ログイン用の URL。ブラウザで開いてログインする。"""
    return (f"{_normalize_url(base_url)}/admin/tool/mobile/launch.php"
            f"?service={service}&passport={passport}&urlscheme=moodlemobile")


def parse_sso_token(launch_result: str, base_url: str | None = None,
                    passport: str | None = None) -> str:
    """ログイン後の moodlemobile://token=... からトークンを取り出す。

    中身は base64(署名:::トークン[:::プライベートトークン])。
    URL と passport が分かれば署名(md5(サイトURL + passport))も確かめる。
    """
    import base64
    import binascii
    import hashlib

    s = launch_result.strip().strip('"').strip("'")
    if "token=" in s:
        s = s.split("token=", 1)[1]
    s = s.split("&", 1)[0].split("#", 1)[0]
    try:
        decoded = base64.b64decode(s + "=" * (-len(s) % 4)).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as e:
        raise MoodleError("貼り付けた文字列を読み取れませんでした。moodlemobile://token=... 全体をコピーしてください。",
                          "badssotoken") from e
    parts = decoded.split(":::")
    if len(parts) < 2 or not parts[1]:
        raise MoodleError("トークンが含まれていませんでした。", "badssotoken")
    if base_url and passport:
        site = _normalize_url(base_url)
        candidates = {hashlib.md5((u + passport).encode()).hexdigest()
                      for u in (site, site.replace("https://", "http://"))}
        if parts[0] not in candidates:
            raise MoodleError("署名が一致しません。今回表示した URL でログインし直してください。",
                              "badssosignature")
    return parts[1]


def _flatten(params: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """Moodle REST が受け付ける形式 (courseids[0]=1 など) に配列・辞書を展開する。"""
    flat: dict[str, Any] = {}
    for key, value in params.items():
        name = f"{prefix}[{key}]" if prefix else str(key)
        if isinstance(value, dict):
            flat.update(_flatten(value, name))
        elif isinstance(value, (list, tuple)):
            flat.update(_flatten(dict(enumerate(value)), name))
        elif isinstance(value, bool):
            flat[name] = int(value)
        elif value is not None:
            flat[name] = value
    return flat


class MoodleClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = _normalize_url(base_url)
        self.token = token
        self.session = requests.Session()

    def call(self, wsfunction: str, **params: Any) -> Any:
        """任意の wsfunction を呼ぶ。エラー時は MoodleError を投げる。"""
        payload = {
            "wstoken": self.token,
            "wsfunction": wsfunction,
            "moodlewsrestformat": "json",
            **_flatten(params),
        }
        resp = self.session.post(
            self.base_url + "/webservice/rest/server.php", data=payload, timeout=TIMEOUT
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict) and "exception" in data:
            raise MoodleError(data.get("message", data["exception"]), data.get("errorcode"))
        return data

    def site_info(self) -> dict[str, Any]:
        return self.call("core_webservice_get_site_info")
