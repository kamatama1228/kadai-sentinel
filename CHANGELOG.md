# 変更の記録

更新(`git pull`)したら `uv run moodle whatsnew` で、前に見たときからの変更が表示されます。
「更新したらやること」がある版は、上から順に済ませてください。

バージョンの付け方:利用者の操作が必要な変更(設定の形・コマンド・`custom/` の書き方が変わる)は真ん中の数字(1.**1**.0)、それ以外の直しは最後の数字(1.0.**1**)を上げます。大きく作り変えたときだけ最初の数字を上げます。

## 1.0.1 — 2026-10-28

GitHub 上の自動テストの安全性を上げました。利用者の操作は不要です。
- アクションを最新の版にし、コミットの SHA で固定した。Dependabot で更新を知らせる(非公開版のみ)
- 自動テストに書き込みの権限を渡さない・認証情報を残さない・npm のインストール時スクリプトを動かさない
- Python は uv.lock の版どおりに入れて確かめる。Node.js は 22 と 24 の両方で確かめる

## 1.0.0 — 2026-10-26

自分用の設定・コードを本体から切り離し、本体を直し続けても各自の変更とぶつからないようにしました。

### 変わったこと
- 設定を `config/` フォルダの JSON に分けられるようにした。授業ごとに1ファイル(`config/courses/授業ID.json`)、全体は `config/settings.json`。`config/` は Git に入らない
- 設定の形を `schema/` の JSON Schema で決めた。VS Code で項目の候補と説明が出る
- 設定のコマンドを追加:`uv run moodle config check`(検査。知らない項目には近い名前を提案)/ `config show`(授業ごとの通知を日本語で表示)/ `config add-course 授業ID` / `config migrate`(notify.toml → config/)
- 自分用のコード `custom/hooks.ts` で、送る直前の通知を書き換えられるようにした(失敗しても元の通知を送る)。書き方は docs/EXTEND.md
- 通知は Cloudflare 版だけにした。PC で常駐させる版(`uv run moodle watch` / `notify`)は終了。同じ判定を2か所に書いていて、片方だけ直してずれる危険があったため
- Cloudflare 版のデプロイは `npm run deploy` になった。設定をまとめ、誤りがあればデプロイせずに止まる
- 通知のテストを入れた(`cd worker` → `npm test`)
- この CHANGELOG と `uv run moodle whatsnew` を追加
- `notify.toml` はそのまま使える(`config/` があればそちらが上書き)
- 直した不具合:授業の曜日(`days`)だけを書いた授業で、個人の未提出リマインドが届かなくなっていた

### 更新したらやること
1. `uv sync`
2. Cloudflare 版を使っている人:`cd worker` → `npm install` → `npm run deploy`。これからは `npx wrangler deploy` ではなく `npm run deploy` を使う
3. PC 版(`uv run moodle watch`)を自動起動にしていた人:PowerShell で `Unregister-ScheduledTask -TaskName moodle-watch -Confirm:$false` を実行して登録を消し、Cloudflare 版に切り替える
4. 設定のコマンドには Node.js 22.6 以上が要る(Cloudflare 版を動かすのに入れたもの)。古い場合は `winget install -e --id OpenJS.NodeJS.LTS`
5. (任意)`uv run moodle config migrate` で notify.toml を config/ に移す。通知のルールが変わらないことを確かめてから入れ替える

## 0.x — 2026-10-09 〜 2026-10-21

最初の版から 1.0.0 の前までのまとめ。
- 課題・小テスト・締切を Moodle から読み、Discord の共有チャンネルと個人チャンネルに知らせる(Cloudflare Workers で 24 時間)
- 小テストの公開の瞬間・公開予定・締切の変更・締切前のリマインド・当日朝の予告
- オンライン授業の日の朝の通知、共有にない授業の締切変更とお知らせ、`[[mute]]`
- 送れなかった通知の送り直し、二重送信の防止、設定の誤りやトークン切れの知らせ
- 手元の AI(Claude Code・Codex・Antigravity)から使うためのコマンドと AGENTS.md
