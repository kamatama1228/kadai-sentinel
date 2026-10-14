# kadai-sentinel 設計ドキュメント

## 目的

Moodle の課題・小テスト・締切・配布資料を取得し、

1. **Discord に自動で知らせる**(見張り・お知らせ)
2. **手元の AI から Moodle の情報を読めるようにする**

ためのツール。Moodle を使っている大学・学校なら、設定を変えるだけで使える。

## 設計原則

1. **読み取り専用**:Moodle には何も書き込まない。提出は利用者が Moodle の画面で行う。
2. **各自が自分のトークンで動かす**:中央サーバーを置かない。認証情報は本人だけが管理する場所(PC の `.env`、本人の Cloudflare の Secrets)に置く。
3. **大学固有の値は設定だけに置く**:URL・授業ID・時間割をコードに書かない。個人設定(`.env`・`notify.toml`)は Git に入れない。
4. **コアは1つ、窓口は複数**:Moodle との通信と整形は `core/` に集約し、CLI・通知はその薄いラッパーにする。
5. **大学のサーバーに優しく**:ふだんは1日数回だけ確認し、必要な時刻・時間帯だけ間隔を短くする。
6. **資料と状態は非公開**:授業資料・通知の状態・提出状況は、公開リポジトリにも、履修者以外がいる場所にも出さない。

## 構成

```
core/       Moodle 通信(トークン、Web サービス呼び出し)と、Task / Activity への整形
cli/        `uv run moodle ...` のコマンド(人と AI エージェントの窓口)
notifier/   通知の判定と Discord 送信(PC で動かす版)
worker/     通知の Cloudflare Workers 版(TypeScript。判定は notifier/ と同じ)
scripts/    Windows で PC 版を常駐させるスクリプト
AGENTS.md   AI エージェント向けの使い方とルール(CLAUDE.md・GEMINI.md から参照)
```

### 認証

- ユーザー名・パスワードの大学:`login/token.php`(サービス `moodle_mobile_app`)
- SSO の大学:公式モバイルアプリと同じ `admin/tool/mobile/launch.php` を使い、ブラウザでログインしたあとの `moodlemobile://token=...` からトークンを取り出す。署名(md5(サイトURL + passport))を検証する

### 主に使う Web サービス関数

| 関数 | 用途 |
| --- | --- |
| `core_webservice_get_site_info` | 接続確認 |
| `core_calendar_get_action_events_by_timesort` | 自分のやること一覧(提出済みは出ない) |
| `core_course_get_enrolled_courses_by_timeline_classification` | 履修中の授業 |
| `mod_quiz_get_quizzes_by_courses` / `mod_assign_get_assignments` | 授業の小テスト・課題(自分の提出状況と無関係) |
| `core_calendar_get_calendar_events` | アンケートなどの開始・終了予定 |
| `mod_assign_get_submission_status` | 自分の提出状況(表示のみ) |
| `core_course_get_contents` | 配布資料 |

## Discord 通知

### 2つのチャンネル

|  | 共有チャンネル | 個人チャンネル |
| --- | --- | --- |
| 内容 | `notify.toml` で有効にした授業の課題・小テスト | 自分の未提出課題のリマインド |
| 情報源 | 授業の課題・小テスト一覧(提出状況と無関係) | やること一覧 |
| 設定 | `DISCORD_WEBHOOK_URL` | `PERSONAL_WEBHOOK_URL` |

共有チャンネルの情報を提出状況と無関係に取るのは、自分が先に提出しても友達へのリマインドが止まらないようにするため。提出状況(個人情報)は共有チャンネルに出さない。

### 通知の種類

| 種類 | 内容 |
| --- | --- |
| `new` | 新しい課題・小テスト |
| `scheduled` | 公開日時が決まっているものが登録された(「〇時に公開予定」) |
| `open` | 公開された瞬間。受付が数分しかない小テスト向け。単独・赤色で送る |
| `due_changed` | 締切の変更 |
| `remind` | 締切の `7d` `1d` `3h` 前、または締切日の `@16:30` など |
| `morning` | 当日の朝の予告 |
| `[[event]]` | Moodle に掲載される前から分かっている予定の手動登録。掲載されたら自動で切り替わる |

### 確認のタイミング

- ふだんは `schedule` の時刻(既定 10:00 と 22:00)だけ
- `fast_windows` の時間帯と、小テスト公開の1分前〜15分後は1分おき
- リマインドの時刻・公開予定時刻が分かっているものは、その時刻ちょうどにも確認する
- 確認できなかった時刻(PC のスリープなど)は、次に動いたときにすぐ確認する

### うるさくしない工夫

- 初回は今の状態を記録するだけで通知しない
- 4件以上たまったら1つにまとめる(急ぎのものは単独)
- 同じ通知は二度送らない(状態を保存する)

### 動かす場所

| 場所 | 特徴 |
| --- | --- |
| Cloudflare Workers(推奨) | 無料、24時間。1分おきの Cron で起動し、KV に保存した「次に確認する時刻」のときだけ Moodle を確認する(起動は1日約1,440回で、無料枠の約1.4%) |
| PC(`uv run moodle watch`) | 手軽。PC が止まると通知も止まる。二重起動はロックファイルで防ぐ |

## AI との連携

- コマンドを実行できる AI(Claude Code・Codex CLI・Antigravity(旧 Gemini CLI)など)は `AGENTS.md` を読んで CLI を使う
- `AGENTS.md` には、トークンを表示しない、ログインは本人が行う、Discord 投稿は確認してから、資料を外部に出さない、などのルールを書く
- 将来、チャットアプリからも使えるように MCP サーバーを用意することを検討する

## 拡張

`cli/main.py` は、`moodle_tool_addons` という別パッケージがインストールされていれば、そのコマンドを追加で読み込む。本体は読み取り専用のまま、追加機能を別に配布できる。

## 公開・配布

- リポジトリに含めない:`.env`、`notify.toml`、`state/`、`materials/`、`submissions/`
- 公開前に、利用する大学の規約で API・外部ツールの扱いを確認する
- ライセンス:MIT
- 名前に「Moodle」を使わない(Moodle は Moodle Pty Ltd の商標)
- 公開されるのはコードだけ。動かすのは各自の Cloudflare アカウントで、外から呼べる URL も作らない
