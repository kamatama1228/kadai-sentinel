// 自分用のコードの例(Cloudflare 版)。使うときは custom/hooks.ts にコピーして、npm run deploy
// 書き方とルールは docs/EXTEND.md。custom/ は Git に入らないので、本体の更新(git pull)とぶつからない
import type { Notice } from "../worker/src/discord.ts";
import type { HookContext } from "../worker/src/hooks.ts";

/**
 * 送る直前に呼ばれる。通知の配列を受け取り、送りたい通知の配列を返す。
 * - 中身を書き換える・消す・足すことができる
 * - エラーになったら、この関数はなかったことにして元の通知を送る
 */
export function beforeSend(notices: Notice[], ctx: HookContext): Notice[] {
  return notices
    // 例1:個人チャンネルでは、見出しの前に印をつける
    .map((n) => ctx.channel === "personal" ? { ...n, heading: `📌 ${n.heading}` } : n)
    // 例2:夜 0 時〜6 時の「お知らせ」は送らない(急ぎのものは送る)
    .filter((n) => n.urgent || !(ctx.local.h < 6 && n.heading.includes("お知らせ")));
}
