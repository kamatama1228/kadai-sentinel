# 自分用にカスタマイズする

通知の内容やタイミングを、自分用に変えるための手順と、安全に変えるための約束です。
AI(Claude・Antigravity など)に「〇〇の授業の通知を 16:30 にして」と頼むと、このページと `AGENTS.md` の決まりに沿って設定ファイルを書き換えてくれます。

**自分用のものは、全部 `config/` と `custom/` の2つのフォルダに入れます。** この2つは Git に入らないので、本体を更新(`git pull`)してもぶつかりません。本体のファイル(`worker/` `notifier/` `core/` など)は変えないでください。

| やりたいこと | 書く場所 | 本体の更新とぶつかるか |
| --- | --- | --- |
| 授業ごとに、何を・いつ知らせるか | `config/courses/授業ID.json`(1授業1ファイル) | ぶつからない |
| 全体の設定(確認する時刻、朝の通知の時刻、お知らせ) | `config/settings.json` | ぶつからない |
| 特定の通知だけ消したい | 授業ファイルか `config/settings.json` の `mute` | ぶつからない |
| Moodle に載る前の締切を登録したい | `config/events/好きな名前.json` | ぶつからない |
| 文面を変える・通知を選ぶなど、設定ではできないこと | `custom/hooks.ts` | ぶつからない([EXTEND.md](EXTEND.md)) |
| それでもできないこと | 本体に入れてもらうよう相談する | — |

> 昔からの `notify.toml` もそのまま使えます。`notify.toml` と `config/` の両方がある場合は、`config/` が上書きします。まとめたいときは `uv run moodle config migrate`(変換前と通知のルールがまったく同じになることを確かめてから入れ替えます)。

---

## はじめの一歩

```powershell
uv run moodle courses                  # 授業ID を調べる
uv run moodle config add-course 12345  # config/courses/12345.json を作る(授業名は Moodle から取る)
uv run moodle config check             # 書き間違いがないか調べる
uv run moodle config show              # 授業ごとに、今どう通知されるかを日本語で表示
```

ひな形は `examples/config/` にあります。丸ごと `config/` にコピーして書き換えてもかまいません。
VS Code などで開くと、ファイル先頭の `"$schema"` のおかげで、書ける項目の候補と説明が出ます。

## 授業ごとの設定(config/courses/授業ID.json)

```json
{
  "$schema": "../../schema/course.schema.json",
  "id": 12345,
  "name": "〇〇演習",
  "shared": {
    "enabled": true,
    "events": ["new", "due_changed"],
    "remind": ["7d", "1d"]
  },
  "personal": {
    "notify": true,
    "remind": ["@16:30"]
  },
  "days": ["thu"],
  "mute": [
    { "channel": "personal", "heading": "お知らせ" }
  ]
}
```

| 項目 | 意味 | 例 |
| --- | --- | --- |
| `id` | 授業ID(ファイル名と同じにする) | `12345` |
| `name` | 授業名(自分が見て分かるため) | `"〇〇演習"` |
| `shared.enabled` | 共有チャンネル(友達全員)に流すか | `true` |
| `shared.events` | 流すもの:`new` 新しく出た / `scheduled` 公開予定 / `open` 受付開始の瞬間 / `due_changed` 締切の変更 | `["new", "open"]` |
| `shared.remind` | 共有チャンネルで締切の何前に知らせるか | `["7d", "1d"]` |
| `shared.morning` | 当日の朝に「今日〇時から小テスト」と予告する | `true` |
| `shared.kinds` | 対象の種類(既定は小テストと課題) | `["小テスト", "課題", "アンケート"]` |
| `shared.match` | 名前にこれを含むものだけ | `["希望調査"]` |
| `personal.notify` | `false` にすると、この授業の個人通知を送らない | `false` |
| `personal.remind` | 個人チャンネルで、未提出の締切の何前に知らせるか | `["1d", "3h"]` |
| `days` | 授業の曜日(オンライン授業の朝の通知に使う) | `["thu"]` |
| `mute` | この授業の通知のうち消したいもの | 下の「通知を消す」 |

- 時間の書き方:`"7d"`(7日前)、`"3h"`(3時間前)、`"30m"`(30分前)、`"@16:30"`(締切日の 16:30)
- `"_メモ": "..."` のように `_` で始まる項目は、メモとして無視されます(JSON にはコメントが書けないため)
- `shared` は、共有チャンネルを動かしている人だけが書きます。ほかの人は `personal` と `mute` だけで足ります

## 全体の設定(config/settings.json)

| 項目 | 意味 | 例 |
| --- | --- | --- |
| `watch.schedule` | ふだん Moodle を確認する時刻(1日 12 回まで) | `["10:00", "22:00"]` |
| `watch.morning_at` | 朝の予告・オンライン授業の通知を送る時刻 | `"07:30"` |
| `watch.fast_windows` | 短い間隔で確認する時間帯(1つ 4 時間まで) | `[{ "days": ["thu"], "start": "13:00", "end": "15:00" }]` |
| `personal.remind` | 個人リマインドの既定(授業ファイルに書かなかった授業) | `["1d", "3h"]` |
| `personal.mirror_shared` | 共有チャンネルの通知を個人にも送る | `true` |
| `personal.changes` | 共有にない授業の締切変更を知らせる | `true` |
| `personal.news` | 共有にない授業の「お知らせ」:`keywords`(休講などだけ)/ `all` / `off` | `"keywords"` |
| `online.enabled` / `online.shared` | オンライン授業の朝の通知 / 共有にも流すか | `true` |
| `default` | 授業ファイルに書かなかった授業の、共有チャンネルの既定 | `{ "enabled": false }` |
| `mute` | 全体で消したい通知(`course` で授業を指定できる) | 下の「通知を消す」 |

## 通知を消す(mute)

書いた条件をすべて満たす通知だけが消えます。

```json
"mute": [
  { "channel": "personal", "heading": "お知らせ" },
  { "title": "アンケート" }
]
```

- `channel`:`shared`(共有)/ `personal`(個人)/ `both`(両方。既定)
- `title`:課題名などにこの文字を含む / `heading`:見出し(「お知らせ」「締切まで」など)にこの文字を含む
- 全体の `mute` で条件が1つもないものはエラーになります(全部消えてしまうため)
- `shared` と `both` は友達全員に効きます。共有チャンネルを動かしている人以外は `personal` にしてください

## Moodle に載る前の締切(config/events/*.json)

```json
{
  "$schema": "../../schema/event.schema.json",
  "events": [
    { "title": "配属希望調査", "course_id": 12345, "course": "〇〇", "due": "2026-11-06 10:30", "remind": ["1d", "3h"], "match": ["希望調査"] }
  ]
}
```

Moodle に同じ名前(`match`)のものが載ったら、自動でそちらに切り替わります。

## 変えたあと

1. `uv run moodle config check` で誤りがないか確かめる(誤りがあれば、どのファイルのどこがおかしいかと、直し方の候補が出ます)
2. `uv run moodle config show` で、思ったとおりの通知になっているか確かめる
3. Cloudflare 版を使っている人は、`cd worker` → `npm run deploy` で反映する
   - 設定に誤りがあると、ここで止まってデプロイされません(動いている版はそのまま)
   - `npx wrangler deploy` を直接使うと、設定の変更が反映されません

## 変えるときの約束(通知が止まる・増えすぎるのを防ぐため)

- **共有チャンネルの Webhook(`DISCORD_WEBHOOK_URL`)は、共有チャンネルを動かしている 1 人だけが持つ。** ほかの人は `.env` で空のままにする(同じ通知が友達全員に何重にも届くのを防ぐ)
- **確認の間隔を短くしない。** `fast` を 1m より短く、`fast_windows` を長くすると大学のサーバーに負担がかかる(書けないように上限がある)
- `.env`(トークン・Webhook)を AI のチャットや GitHub に貼らない
- 変える前にコピーを取る:`config/` を `state/` にコピーしておく(`state/` も Git に入らない)
- 本体のファイルを変えたくなったら、まず [EXTEND.md](EXTEND.md) の `custom/` でできないか考える。それでも無理なら、本体に入れてもらうよう相談する

## 安全のための仕組み(最初から入っているもの)

| 起きること | どうなるか |
| --- | --- |
| 設定の書き間違い | `config check` と `npm run deploy` が止めて教える。それでもすり抜けたら、通知は止まるが個人チャンネルに 1 日 1 回知らせる |
| `custom/` のコードが失敗した | そのコードはなかったことにして、元の通知を送る |
| Moodle が止まった・トークン切れ | 個人チャンネルに知らせる(24 時間に 1 回) |
| Discord に送れなかった | 送れなかった分だけ、あとで送り直す(締切を過ぎたものは送らない) |
| 一度にたくさん出た | 4 件以上は 1 通にまとめる(急ぎのものも) |
| 確認が重なった | 同じ通知を二重に送らない |
| 1 つの授業だけ情報が取れない | その授業だけ飛ばして、ほかは通知する |

> 通知は Cloudflare 版だけで動きます。`uv run moodle config ...` は、中で Node.js(22.6 以上。Cloudflare 版を動かすのに入れたもの)を使います。
