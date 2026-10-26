// デプロイの前に、設定(notify.toml / config/)と自分用のコード(custom/)を1つにまとめて worker/.generated/ に書き出す。
// `npm run deploy` から自動で呼ばれる。`npm run check` なら書き出さずに検査だけする。
// 設定に誤りがあればここで止まるので、誤った設定がデプロイされることはない(動いている版はそのまま)。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(here, "..", ".generated");
const checkOnly = process.argv.includes("--check");

// notify.toml を使っているときだけ TOML の読み込み部品を読む
const parse = existsSync(join(root, "notify.toml")) ? (await import("smol-toml")).parse : () => ({});
const { data, errors, sources } = loadConfig(root, parse);
if (errors.length) {
  console.error("設定に誤りがあります(デプロイしません):");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`設定: ${sources.length ? sources.join(", ") : "(なし。既定の設定で動きます)"}`);
const hooks = existsSync(join(root, "custom", "hooks.ts"));
console.log(`自分用のコード: ${hooks ? "custom/hooks.ts を使います" : "なし"}`);
if (checkOnly) process.exit(0);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "config.json"), JSON.stringify(data, null, 1));
writeFileSync(join(out, "custom.ts"), hooks
  ? `// 自動で作るファイル(編集しない)\nimport * as user from "../../custom/hooks.ts";\nexport const hooks: Record<string, unknown> = user;\n`
  : `// 自動で作るファイル(編集しない)。custom/hooks.ts がないとき\nexport const hooks: Record<string, unknown> = {};\n`);
