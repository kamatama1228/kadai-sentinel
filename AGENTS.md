# AI エージェント向けの説明

このリポジトリは、Moodle の情報を読み取り、Discord に通知するためのツールです。
利用者に頼まれたら、以下のコマンドで Moodle の情報を取得して答えてください。

## 使えるコマンド(すべて読み取り専用)

| コマンド | 内容 |
| --- | --- |
| `uv run moodle tasks` | やること一覧(未提出の課題・小テスト)。`--json` で機械向け、`--days 14` で期間指定 |
| `uv run moodle courses` | 履修中の授業と授業ID |
| `uv run moodle assign <課題名か課題ID>` | 課題の締切・提出方法・自分の提出状況 |
| `uv run moodle files [--course 授業名]` | 配布資料を `materials/<授業>/<回>/` にダウンロード(更新分だけ) |
| `uv run moodle check` | 接続確認 |

資料の中身を読むときは、`materials/` 以下のファイルを開いてください(PDF はテキスト抽出してから読む)。

## 守ること

- **`.env` の中身(特に `MOODLE_TOKEN` と Webhook の URL)を表示・出力・送信しない。** 設定の確認が必要なら、値ではなく「設定されているか」だけを確かめる。
- **ログインは利用者本人が行う。** `uv run moodle login` をエージェントが代わりに実行したり、パスワードやトークンを尋ねたりしない。
- **Discord に投稿するコマンド**(`uv run moodle notify`、`notify --test`)は、利用者に確認してから実行する。
- **`materials/` の資料を外部に送ったり、リポジトリにコミットしたりしない。** 資料の著作権は担当教員にある。要約・解説など、利用者本人の学習のために使う。
- **このリポジトリに `git push` しない。** 利用者に頼まれても、push は利用者本人がコマンドを打つ。push 先の設定(`git remote set-url`、`no-push` の設定)を変えたり外したりしない。`git commit` も、利用者がはっきり頼んだときに自分用のブランチでだけ行う
- **Moodle に何かを書き込む操作は、このツールにはない。** 課題の提出は、利用者が Moodle の画面で行う。
- 大学のサーバーに負荷をかけないよう、同じコマンドを短い間隔で何度も実行しない。
- `addons/` に追加機能が入っている場合は、その中の `AGENTS.md` も読み、そこに書かれたルールに従う。
- 設定(`config/` や `notify.toml`)や `custom/` を変えたら、Cloudflare 版を使っている場合は `cd worker && npm run deploy` が必要だと利用者に伝える(`npx wrangler deploy` を直接使うと設定が反映されない)。

## 通知の設定を変えてと頼まれたら

書ける項目と書き方は **docs/CUSTOMIZE.md** にある。変える前に必ず読む。項目の正確な形は `schema/*.schema.json`。

- **自分用のものは `config/`(設定)と `custom/`(コード)だけに書く。** どちらも Git に入らないので、本体の更新とぶつからない。本体のファイル(`worker/` `core/` `cli/` `schema/`)は変えない
  - 授業ごとの設定 → `config/courses/授業ID.json`(1授業1ファイル。なければ `uv run moodle config add-course 授業ID` で作る)
  - 全体の設定(確認の時刻、朝の時刻、お知らせなど)→ `config/settings.json`
  - 通知を消す → 授業ファイルか `config/settings.json` の `mute`
  - 設定ではできないこと(文面を変えるなど)→ `custom/hooks.ts`(書き方は **docs/EXTEND.md**)。それでも無理なら本体の変更になるので、利用者に「本体の持ち主に相談する」よう伝える
- 利用者が `notify.toml` を使っている場合は、`notify.toml` を書き換えてもよい(`config/` が上書きする)。`config/` に移すかは利用者に聞く(`uv run moodle config migrate`。勝手に実行しない)
- **変える前に、変えるファイルを `state/` にコピーする**(`state/` は Git に入らない)。うまくいかなければ戻す
- **変えたら必ず `uv run moodle config check` を実行し、`uv run moodle config show 授業` で思ったとおりになったか確かめる。** 誤りが出たら直してから終える
- **共有チャンネル(友達全員)に影響する変更は、共有チャンネルを動かしている本人か確認してからにする。** 授業ファイルの `shared`、`channel` が `"shared"` / `"both"` の `mute`、`online.shared`、`custom/` で共有チャンネルの通知を変えるもの など
- **確認の間隔を短くする変更(`fast`、`fast_windows`、`schedule` を増やす)は、大学のサーバーに負担がかかるので勧めない。** 上限を超える書き方はエラーになる
- `.env` の Webhook(特に共有チャンネルの `DISCORD_WEBHOOK_URL`)を書き換えたり、別の人の `.env` に入れたりしない
- 変えたら、何をどう変えたかを短く伝える。Cloudflare 版を使っている場合は `cd worker` → `npm run deploy` が必要だと伝える(設定に誤りがあればそこで止まり、動いている版はそのまま)。誤りがすり抜けると、個人チャンネルに「設定に誤りがあり、通知が止まっています」と届くので、届いたら直す

## 更新(git pull)のとき

- `git pull` のあとは必ず `uv sync` と `uv run moodle whatsnew` を実行し、何が変わったかと「更新したらやること」を利用者に短く伝える。やることがあれば、1つずつ一緒に進める
- 設定のコマンド(`uv run moodle config ...`)は Node.js 22.6 以上を使う。入っていないと言われたら、利用者に入れ方を伝える(Cloudflare 版を使わない人には不要)

## 本体を直すとき(本体の持ち主が頼んだときだけ)

- 変える前と後に `cd worker` → `npm test` を実行し、全部通ることを確かめる。新しい動きにはテストを足す(テストは架空の授業で書き、本物の授業名や ID を入れない)
- 変えたら CHANGELOG.md に1行で書く。利用者の操作が必要な変更(設定の形が変わる、コマンドが変わる、`custom/` の書き方が変わる)は「更新したらやること」に書き、バージョンを上げる(`pyproject.toml`・`worker/package.json`・CHANGELOG.md の3か所。テストがそろっているかを確かめる)

## 利用者への伝え方

- 利用者は PC やコマンドに詳しくないことがある。コマンドはエージェントが代わりに実行し(ログインを除く)、結果は表をそのまま貼らずに「今週やること」として短くまとめる。
- 利用者に操作してもらう必要があるときは、どの画面で何を押すかを1つずつ書く。一度にたくさんの手順を並べない。
- エラーが出たら、原因の見当と次にやることを1つだけ伝える。トークン切れ(`invalidtoken`)なら、本人に `uv run moodle login --sso` をやり直してもらう。
