# kadai-sentinel

**課題の見張り番。** Moodle の課題・小テスト・締切を見張って **Discord に知らせ**、手元の AI(Claude・ChatGPT・Gemini など)から **Moodle の情報を読めるようにする**ためのツールです。

Moodle を使っている大学・学校ならどこでも、設定を変えるだけで使えます。
(Moodle は Moodle Pty Ltd の商標です。このツールは Moodle 公式とは関係ありません。)

## できること

- **Discord 通知**:新しい課題、締切の変更、締切前のリマインド、授業中に短時間だけ公開される小テストの「公開された瞬間」の通知
  - 友達との共有チャンネル(授業の情報)と、自分専用チャンネル(自分の未提出課題)を分けて送れる
  - 授業ごとに、何をいつ知らせるかを `notify.toml` で決められる
  - Cloudflare Workers(無料)で 24 時間動かせる。PC が閉じていても届く
  - Moodle を確認するのは決めた時刻だけ(ふだんは 1 日 2 回、短い小テストがある時間帯だけ 1 分おき)。大学のサーバーに優しい
- **AI から Moodle を読む**:やること一覧、授業一覧、課題の詳細、配布資料のダウンロード
  - Claude Code / Codex CLI / Gemini CLI などの「コマンドを実行できる AI」は、`AGENTS.md` を読んでこのツールを使える
- **読み取り専用**:Moodle に何かを書き込んだり提出したりはしません

## 必要なもの

- Python 3.11 以上と [uv](https://docs.astral.sh/uv/)
- (Discord 通知を 24 時間動かす場合)Node.js と Cloudflare の無料アカウント
- あなたの大学の Moodle で、モバイルアプリ用の Web サービスが有効になっていること(公式 Moodle アプリが使えれば、たいてい有効です)

## 1. セットアップ

```bash
uv sync
cp .env.example .env               # MOODLE_URL を自分の大学のものに書き換える
uv run moodle diagnose             # ログイン方式を調べる
uv run moodle login                # ユーザー名・パスワードでログインできる大学
uv run moodle login --sso          # SSO(学内の共通ログイン画面)を使う大学
uv run moodle check                # 接続確認
```

パスワードは保存しません。取得したトークンだけが `.env` に保存されます。

### SSO の大学でのトークン取得

`login --sso` を実行すると URL が表示されます。

1. ブラウザで開発者ツール(F12)を開き、「ネットワーク」タブで「ログを保持」にチェックを入れる
2. 表示された URL を開き、いつもの画面でログインする(すでにログイン済みなら真っ白な画面になる)
3. 一覧の `launch.php` → レスポンスヘッダーの `location: moodlemobile://token=...` をコピーする
4. ターミナルに戻って Enter(Windows はクリップボードから読み取る。それ以外は貼り付け)

これは公式 Moodle アプリと同じログインの仕組みです。

## 2. 使い方

```bash
uv run moodle tasks                # やること一覧(--url でリンク、--json で機械向け)
uv run moodle courses              # 履修中の授業と授業ID
uv run moodle assign 課題名        # 課題の設定と自分の提出状況
uv run moodle files                # 配布資料を materials/ に取得(更新分だけ)
uv run moodle files --course 授業名 --dry-run
```

## 3. AI とつなぐ

| 使っている AI | つなぎ方 |
| --- | --- |
| Claude Code / Codex CLI / Gemini CLI | このフォルダで起動するだけ。`AGENTS.md`(と `CLAUDE.md` / `GEMINI.md`)を読んで、`uv run moodle ...` を実行してくれる |
| Claude デスクトップアプリ(PC 連携) | このフォルダをチャットに接続すると、スマホからでも「今週の課題は?」と頼める |
| チャットだけの AI | `uv run moodle tasks --json` の結果や `materials/` の資料を貼り付けて使う |

「今週の締切を教えて」「〇〇の第2回の資料を要約して」のように頼めます。

## 4. Discord 通知

1. 通知を流したい Discord チャンネルで、連携サービス → ウェブフック から URL を作り、`.env` の `DISCORD_WEBHOOK_URL` に書く(自分専用のリマインドも使うなら `PERSONAL_WEBHOOK_URL` も)
2. `cp notify.example.toml notify.toml` して、授業ID とルールを書く(書き方はファイル内のコメント)
3. `uv run moodle notify --test personal` で見た目を確認する

### 24 時間動かす(Cloudflare Workers、無料)

```bash
cd worker
npm install
npx wrangler login
cp wrangler.example.toml wrangler.toml    # wrangler.toml は自分用(Git に入らない)
npx wrangler kv namespace create STATE    # 表示された id を wrangler.toml に書く
npx wrangler deploy
npm run secrets                           # .env の URL・トークン・Webhook を Cloudflare に登録(値は表示しない)
npm run tail                              # 1 分以内に「初回: 状態を記録しました」が出れば OK
```

- 1 分おきに起動しますが、Moodle を確認するのは「次に確認する時刻」(既定は 10:00 と 22:00、リマインドや小テストの時刻、`fast_windows` の時間帯)だけです。それ以外の起動はすぐ終わります
- 起動は 1 日約 1,440 回で、無料枠(1 日 10 万回)の約 1.4% です
- `notify.toml` を変えたら `npx wrangler deploy` で反映します
- 外から呼べる URL は作りません。動かすのは各自の Cloudflare アカウントです

### PC で動かす(Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1
```

ログオン時に自動で起動します。PC が止まっているあいだは通知も止まります。Cloudflare 版と同時に動かすと通知が重複するので、どちらか一方にしてください。


## 注意

- **使う前に、自分の大学の情報システム利用規約やガイドラインを確認してください。** このツールは大学・Moodle 公式とは関係ありません。
- **トークンはパスワードと同じです。** `.env` を人に渡したり、コミットしたりしないでください。
- **授業資料の著作権は担当の先生にあります。** `materials/` の資料を、その授業を履修していない人に共有しないでください(`materials/` は Git に入りません)。
- **大学のサーバーに負荷をかけないでください。** 確認間隔を短くしすぎないこと。1 分おきは、本当に必要な時間帯だけにしてください。
- 課題に AI を使うかどうかは、授業ごとのルールに従ってください。

## ライセンス

MIT
