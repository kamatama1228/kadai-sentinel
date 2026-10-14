# kadai-sentinel

![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)

**課題の見張り番。** Moodle の課題・小テスト・締切を見張って Discord に知らせ、手元の AI から Moodle の情報を読めるようにするツールです。


授業中に数分だけ公開される出席小テストを見逃さない。レポートの締切を友達と共有する。配布資料を AI に要約させる。そのために作りました。Moodle を使っている大学・学校なら、設定を変えるだけで使えます。

## 特徴

- **見逃さない通知**:新しい課題、締切の変更、締切前のリマインド、小テストが「公開された瞬間」の通知
- **授業ごとにルールを決められる**:何を・いつ知らせるかを `notify.toml` に書くだけ(「1 週間前と前日」「締切日の 16:30」なども可)
- **共有と個人を分ける**:友達との共有チャンネルには授業の情報だけ、自分の提出状況は自分専用チャンネルだけに
- **大学のサーバーに優しい**:Moodle を確認するのはふだん 1 日 2 回。短い小テストがある時間帯だけ 1 分おき
- **24 時間・無料**:Cloudflare Workers の無料枠で動く。PC を閉じていても届く
- **AI から使える**:Claude Code・Codex CLI・Antigravity(旧 Gemini CLI)などが `AGENTS.md` を読んで、そのまま使える
- **読み取り専用**:Moodle には何も書き込みません

## 仕組み

```mermaid
flowchart LR
    M[(Moodle<br/>Web サービス)] -->|課題・小テスト・締切| C[core<br/>取得と整形]
    C --> CLI[CLI<br/>uv run moodle ...]
    C --> N[通知の判定<br/>notify.toml のルール]
    N -->|共有チャンネル| D1[Discord<br/>友達と]
    N -->|個人チャンネル| D2[Discord<br/>自分だけ]
    CLI --> AI[手元の AI<br/>Claude / Codex / Antigravity]
    W[Cloudflare Workers<br/>または PC 常駐] -. 決めた時刻に起動 .-> N
```

## 通知の例

```
🚨 小テストが公開されました                     ← 赤色・単独で投稿
第3回授業小テスト
授業  〇〇概論
受付  10/15(木) 14:35〜14:44   残り あと 9 分   制限時間 4 分

⏰ 締切まで1日を切りました
レポート1
授業  〇〇演習
締切  11/06(金) 23:59
```

## クイックスタート

```bash
uv sync
cp .env.example .env            # MOODLE_URL を自分の大学のものに
uv run moodle diagnose          # ログイン方式を調べる
uv run moodle login --sso       # SSO の大学(ID・パスワード方式なら --sso なし)
uv run moodle tasks             # やること一覧が出れば OK
```

パスワードは保存しません。トークンだけが `.env` に入ります。

<details>
<summary>SSO の大学でのトークンの取り方</summary>

1. ブラウザで開発者ツール(F12)→「ネットワーク」タブ →「ログを保持」にチェック
2. `login --sso` が表示した URL を開いて、いつもの画面でログイン(ログイン済みなら真っ白な画面になる)
3. 一覧の `launch.php` → レスポンスヘッダーの `location: moodlemobile://token=...` をコピー
4. ターミナルに戻って Enter(Windows はクリップボードから自動で読み取る)

公式 Moodle アプリと同じログインの仕組みです。
</details>

## コマンド

| コマンド | 内容 |
| --- | --- |
| `uv run moodle tasks` | やること一覧(`--url` でリンク、`--json` で機械向け) |
| `uv run moodle courses` | 履修中の授業と授業 ID |
| `uv run moodle assign 課題名` | 課題の設定と自分の提出状況 |
| `uv run moodle files` | 配布資料を `materials/` に取得(更新分だけ) |
| `uv run moodle notify --test personal` | Discord 通知の見た目を確認 |

## AI とつなぐ

| 使っている AI | つなぎ方 |
| --- | --- |
| Claude Code / Codex CLI | このフォルダで起動するだけ。`AGENTS.md` を読んでコマンドを使う |
| Gemini(Antigravity のアプリ・`agy`) | このフォルダを開くだけ。`GEMINI.md` と `AGENTS.md` を読む。PC に慣れていない人向けの手順は [docs/GUIDE_ANTIGRAVITY.md](docs/GUIDE_ANTIGRAVITY.md)(Gemini CLI は 2026年6月に終了) |
| Claude デスクトップアプリ | このフォルダをチャットに接続すると、スマホからでも頼める |
| その他 | `uv run moodle tasks --json` の結果や資料を貼り付ける |

「今週の締切は?」「〇〇の第 2 回の資料を要約して」のように頼めます。

## Discord 通知

1. Discord のチャンネル設定 → 連携サービス → ウェブフック で URL を作り、`.env` に書く(共有用 `DISCORD_WEBHOOK_URL`、自分用 `PERSONAL_WEBHOOK_URL`)
2. `cp notify.example.toml notify.toml` して、授業ごとのルールを書く(書き方はファイル内のコメント)

### Cloudflare Workers で 24 時間動かす(無料)

```bash
cd worker
npm install
npx wrangler login
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create STATE    # 表示された id を wrangler.toml に書く
npx wrangler deploy
npm run secrets                           # .env の値を Cloudflare に登録(画面には出ない)
```

1 分おきに起動しますが、Moodle を確認するのは決めた時刻だけで、それ以外はすぐ終わります(無料枠の約 1.4%)。`notify.toml` を変えたら `npx wrangler deploy` で反映します。

### PC で動かす(Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1
```

ログオン時に自動で起動します。Cloudflare 版と同時に動かすと通知が重複するので、どちらか一方で。

## 設計

考え方や判断の理由は [docs/DESIGN.md](docs/DESIGN.md) にまとめています。

## 注意

- 使う前に、自分の大学の情報システム利用規約を確認してください。このツールは大学・Moodle 公式とは関係ありません(Moodle は Moodle Pty Ltd の商標です)
- トークンはパスワードと同じです。`.env` を人に渡したりコミットしたりしないでください
- 授業資料の著作権は担当の先生にあります。履修していない人に共有しないでください
- 確認の間隔を短くしすぎないでください(1 分おきは本当に必要な時間帯だけ。上限も設けています)
- 課題に AI を使うかどうかは、授業ごとのルールに従ってください

## ライセンス

[MIT](LICENSE)
