// kadai-sentinel の Discord 通知(Cloudflare Workers 版)
// 1分おきに起動し、「次に確認する時刻」になっていたときだけ Moodle を確認する(それ以外はすぐ終わる)。
// 確認する時刻は notify.toml のとおり(ふだんは1日2回、必要な時刻と時間帯だけ1分おき)。状態は KV に保存する。
import { parse } from "smol-toml";
import configText from "../../notify.toml";
import { send, type Notice } from "./discord.ts";
import { fetchActivities, fetchGeneric, fetchTodo, listCourses, Moodle, MoodleError } from "./moodle.ts";
import { manualActivities, nextRunAt, planMorning, planPersonal, planShared, type State } from "./plan.ts";
import { courseRule, parseRules, sharedIds } from "./rules.ts";
import { dateKey, fmtTime } from "./time.ts";

interface Env {
  MOODLE_URL: string;
  MOODLE_TOKEN: string;
  DISCORD_WEBHOOK_URL?: string;
  PERSONAL_WEBHOOK_URL?: string;
  STATE: KVNamespace;
}

const rules = parseRules(parse(configText));

async function run(env: Env, force = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const saved = await env.STATE.get<State>("state", "json");
  if (saved && !force && now < (saved.next_at ?? 0)) return "skip";

  const first = saved === null;
  const state: State = saved ?? { shared: {}, personal: {} };
  const m = new Moodle(env.MOODLE_URL, env.MOODLE_TOKEN);
  try {
    const ids = sharedIds(rules);
    const names = ids.length ? await listCourses(m) : new Map<number, string>();
    const genericIds = ids.filter((id) => courseRule(rules, id).kinds.some((k) => k !== "小テスト" && k !== "課題"));
    let acts = await fetchActivities(m, ids, names);
    acts = acts.concat(await fetchGeneric(m, genericIds, names, now));
    acts = acts.concat(manualActivities(rules, acts));
    const tasks = await fetchTodo(m, now);

    const shared = planShared(acts, state, rules, now, first).concat(first ? [] : planMorning(acts, state, rules, now));
    const personal = planPersonal(tasks, state, rules, now, first);
    for (const [label, list, url] of [["共有", shared, env.DISCORD_WEBHOOK_URL], ["個人", personal, env.PERSONAL_WEBHOOK_URL]] as [string, Notice[], string | undefined][]) {
      for (const n of list) console.log(`[${label}] ${n.heading} | ${n.course} / ${n.title}`);
      if (list.length && url) await send(url, list);
    }
    state.next_at = nextRunAt(rules, acts, tasks, Math.floor(Date.now() / 1000));
    await env.STATE.put("state", JSON.stringify(state));
    return `${first ? "初回: 状態を記録しました。" : ""}共有 ${shared.length} / 個人 ${personal.length} 件。次の確認 ${fmtTime(state.next_at)}`;
  } catch (e) {
    // 失敗したら5分後にもう一度。トークン切れは1日1回だけ自分に知らせる
    const day = dateKey(now);
    if (e instanceof MoodleError && ["invalidtoken", "accessexception"].includes(e.errorcode ?? "")
        && state.last_error_day !== day && env.PERSONAL_WEBHOOK_URL) {
      state.last_error_day = day;
      await send(env.PERSONAL_WEBHOOK_URL, [{
        heading: "⚠️ Moodle に接続できません", courseId: 0, course: "kadai-sentinel",
        title: "トークンが無効になった可能性があります", url: "",
        fields: [["対処", "PC で uv run moodle login --sso → worker で npm run secrets"]], urgent: true,
      }]).catch(() => {});
    }
    if (!first) {
      // 失敗したら5分後にもう一度。トークン切れはすぐ直らないので1時間あける(大学のサーバーを叩き続けない)
      const tokenError = e instanceof MoodleError && ["invalidtoken", "accessexception"].includes(e.errorcode ?? "");
      state.next_at = now + (tokenError ? 3600 : 300);
      await env.STATE.put("state", JSON.stringify(state));
    }
    throw e;
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const r = await run(env);
    if (r !== "skip") console.log(r);
  },

  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
