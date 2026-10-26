# kadai-sentinel 設計ドキュメント

## 目的

Moodle の課題・小テスト・締切・配布資料を取得し、

1. **Discord に自動で知らせる**(見張り・お知らせ)
2. **手元の AI から Moodle の情報を読めるようにする**

ためのツール。Moodle を使っている大学・学校なら、設定を変えるだけで使える。

## 設計原則

1. **読み取り専用**:Moodle には何も書き込まない。提出は利用者が Moodle の画面で行う。
2. **各自が自分のトークンで動かす**:中央サーバーを置かない。認証情報は本人だけが管理する場所(PC の `.env`、本人の Cloudflare の Secrets)に置く。
3. **大学固有の値は設定だけに置く**:URL・授業ID・時間割をコードに書かない。個人設定(`.env`・`config/`・`custom/`・`notify.toml`)は Git に入れない。
4. **コアは1つ、窓口は複数**:Moodle との通信と整形は `core/` に集約し、CLI・通知はその薄いラッパーにする。
5. **大学のサーバーに優しく**:ふだんは1日数回だけ確認し、必要な時刻・時間帯だけ間隔を短くする。
6. **資料と状態は非公開**:授業資料・通知の状態・提出状況は、公開リポジトリにも、履修者以外がいる場所にも出さない。

## 構成

```
core/       Moodle 通信(トークン、Web サービス呼び出し)と、Task / Activity への整形
cli/        `uv run moodle ...` のコマンド(人と AI エージェントの窓口)
worker/     通知(Cloudflare Workers。TypeScript)。通知の判定・設定の解釈はここだけにある
  scripts/  設定のまとめ(build-config.mjs)と設定のコマンド(config-cli.mjs)
  test/     通知と設定のテスト(npm test)。架空の授業で動かす
schema/     設定ファイルの形(JSON Schema)
examples/   設定(config/)と自分用のコード(custom/)のひな形
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
| 内容 | 設定(`config/`)で有効にした授業の課題・小テスト | 自分の未提出課題のリマインド |
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

PC で常駐させる版(Python)は 1.0.0 でやめた。同じ判定を Python と TypeScript の2か所に書くと、片方だけ直してずれる危険があり、実際に PC 版だけ機能が足りなくなっていたため。Python は「Moodle を読むコマンド(人と AI の窓口)」に専念し、通知の判定と設定の解釈は TypeScript の1か所だけにする。`uv run moodle config ...` も、中で Node.js の `worker/scripts/config-cli.mjs` を呼ぶ。

## AI との連携

- コマンドを実行できる AI(Claude Code・Codex CLI・Antigravity(旧 Gemini CLI)など)は `AGENTS.md` を読んで CLI を使う
- `AGENTS.md` には、トークンを表示しない、ログインは本人が行う、Discord 投稿は確認してから、資料を外部に出さない、などのルールを書く
- 将来、チャットアプリからも使えるように MCP サーバーを用意することを検討する

## 設定と拡張(本体を直し続けても、各自の変更とぶつからないように)

このツールは本体を直しながら育てていく前提で作る。各自の変更は Git に入らない2つのフォルダだけに置き、本体のファイルは誰も書き換えない。

| 層 | 場所 | Git | 中身 |
| --- | --- | --- | --- |
| 本体 | `core/` `cli/` `worker/` `schema/` | 入る | コードと、設定の形(JSON Schema) |
| 例 | `examples/config/` `examples/custom/` | 入る | ひな形 |
| 各自の設定 | `config/settings.json` `config/courses/授業ID.json` `config/events/*.json` | 入らない | 1授業1ファイル。人も AI もどこを触ればよいか分かる |
| 各自のコード | `custom/hooks.ts` | 入らない | 送る直前の通知を書き換える拡張口(docs/EXTEND.md) |
| 昔の設定 | `notify.toml` | 入らない | そのまま使える。`config migrate` で config/ に移せる |

- 設定は「既定値 → notify.toml → settings.json → courses/*.json → events/*.json」の順に重ねる(あとが勝つ。オブジェクトは中身ごと、配列は置き換え、mute と events は足す)。まとめる処理は `worker/scripts/config-lib.mjs`、解釈は `worker/src/rules.ts` の1か所だけで、Cloudflare 版・コマンド・テストが同じものを使う
- 設定の形は `schema/*.schema.json` が唯一の定義。エディタの補完、`config check` の検査(知らない項目は近い名前を提案)、AI が読む資料を兼ねる
- Cloudflare 版は実行時にファイルを読めないので、`npm run deploy` のときに `build-config.mjs` が設定を `worker/.generated/config.json` にまとめ、`custom/hooks.ts` を取り込む。設定に誤りがあればここで止まり、デプロイしない
- 自分用のコードが失敗したら、その回は元の通知を送る(壊れても通知は止まらない)。拡張口の形は `HOOKS_API` の数字で管理する

### 追加機能(別配布)

`cli/main.py` は、`moodle_tool_addons` という別パッケージがインストールされていれば、そのコマンドを追加で読み込む。本体は読み取り専用のまま、追加機能を別に配布できる。

## 公開・配布

この公開版は、作者の手元の版から、特定の大学・個人に関わるもの(導入手順・追加機能・設定)を除いて書き出したもの。直すときは手元の版で直してテストし、書き出し直す。


- リポジトリに含めない:`.env`、`config/`、`custom/`、`notify.toml`、`state/`、`materials/`、`submissions/`
- 公開前に、利用する大学の規約で API・外部ツールの扱いを確認する
- ライセンス:MIT
- 名前に「Moodle」を使わない(Moodle は Moodle Pty Ltd の商標)
- 公開されるのはコードだけ。動かすのは各自の Cloudflare アカウントで、外から呼べる URL も作らない
