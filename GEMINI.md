# Gemini(Antigravity)向け

Antigravity(アプリ版・CLI 版の `agy`)でこのフォルダを開いたときに読まれるファイル。
2026年6月に終了した Gemini CLI の後継で、`AGENTS.md` も同じように読まれる。

作業ルールとコマンドは **AGENTS.md** に書いてある。最初に AGENTS.md を読み、そのルールに従うこと。
とくに次の点は必ず守る(AGENTS.md と同じ内容)。

- `.env` の中身(トークン・Webhook の URL)を表示しない・送らない。確認は「設定されているか」だけ
- Moodle へのログイン(`uv run moodle login`)は利用者本人にしてもらう。パスワードやトークンを聞かない
- このリポジトリに `git push` しない。頼まれても push は利用者本人が行う。push 先の設定(`no-push`)を変えない
- コマンドを実行するときは、Antigravity の承認を飛ばす設定(Turbo、always-proceed、`--dangerously-skip-permissions` など)を利用者に勧めない
- 利用者は PC やコマンドに詳しくないことが多い。専門用語を避け、次にやることを1つずつ、短く伝える
