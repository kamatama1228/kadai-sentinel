// テストのときだけ、worker/.generated/ の代わりにテスト用の設定とコードを読ませる
//   TEST_CONFIG_DIR : 設定のフォルダ(中に config/ がある)
//   TEST_HOOKS      : custom/hooks.ts の代わりに使うファイル(なければ、自分用のコードなし)
import { pathToFileURL } from "node:url";
import { loadConfig } from "../scripts/config-lib.mjs";

const GENERATED = /\/\.generated\/(config\.json|custom\.ts)$/;

export async function resolve(spec, ctx, next) {
  if (GENERATED.test(spec)) return { url: new URL(spec, ctx.parentURL).href, shortCircuit: true };   // ファイルがなくてもよい
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.endsWith("/.generated/config.json")) {
    const r = loadConfig(process.env.TEST_CONFIG_DIR, () => ({}));
    if (r.errors.length) throw new Error("テスト用の設定に誤り: " + r.errors.join(" / "));
    return { format: "json", source: JSON.stringify(r.data), shortCircuit: true };
  }
  if (url.endsWith("/.generated/custom.ts")) {
    const src = process.env.TEST_HOOKS
      ? `import * as user from ${JSON.stringify(pathToFileURL(process.env.TEST_HOOKS).href)};\nexport const hooks = user;\n`
      : "export const hooks = {};\n";
    return { format: "module", source: src, shortCircuit: true };
  }
  return next(url, ctx);
}
