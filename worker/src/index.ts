// kadai-sentinel の Discord 通知(Cloudflare Workers 版)
// 1分おきに起動し、「次に確認する時刻」になっていたときだけ Moodle を確認する(それ以外はすぐ終わる)。
// 確認する時刻は notify.toml のとおり(ふだんは1日2回、必要な時刻と時間帯だけ1分おき)。状態は KV に保存する。
import { parse } from "smol-toml";
import configText from "../../notify.toml";
import { DiscordError, send, sendPlain, type Notice } from "./discord.ts";
import { fetchActivities, fetchAttendance, fetchGeneric, fetchNews, fetchTodo, fetchUrls, isSubmitted, listCourses, Moodle, MoodleError,
         type Activity, type Task } from "./moodle.ts";
import { manualActivities, mirrorShared, needsSubmitCheck, nextRunAt, planNews, planOnlineToday, refreshOnline, planMorning, planPersonal, planShared, type Pending, type State } from "./plan.ts";
import { courseRule, muted, parseRules, sharedIds, type Rules } from "./rules.ts";
import { fmtTime } from "./time.ts";

interface Env {
  MOODLE_URL: string;
  MOODLE_TOKEN: string;
  DISCORD_WEBHOOK_URL?: string;
  PERSONAL_WEBHOOK_URL?: string;
  STATE: KVNamespace;
}

// notify.toml の読み込み。誤りがあっても黙って止まらないよう、誤りの内容を覚えておいて自分に知らせる
let rules: Rules;
let configError: string | null = null;
try { rules = parseRules(parse(configText)); }
catch (e) { configError = String(e instanceof Error ? e.message : e); rules = undefined as unknown as Rules; }
const EXTRAS_EVERY = 3 * 3600 - 300;   // オンライン授業・お知らせの取得は約3時間に1回(1分おきの時間帯でも増やさない)
const PENDING_TTL = 12 * 3600;         // Discord に送れなかった通知は、12時間まで(締切・公開時刻を過ぎたらそこまで)送り直す
const PENDING_RETRY = 5 * 60;          // 送り直しは5分おき(急ぎの通知があれば1分おき)。Moodle には問い合わせない
const PENDING_KEEP = 100;              // 送り直し待ちとして残す上限(今回送る分は全部送る)
const URGENT_FAST_RETRY = 30 * 60;     // 急ぎの通知を1分おきに送り直すのは最初の30分だけ(KV の書き込み回数を抑える)
const LOCK = 5 * 60;                   // 確認中に次の起動が重ならないよう、この間は次を始めない
const STALE_ALERT = 6 * 3600;          // Moodle の確認が「失敗し続けて」6時間たったら知らせる(確認しない時間は数えない)

type Channel = "shared" | "personal";

function alert(title: string, how: string): Notice {
  return { heading: "⚠️ kadai-sentinel が Moodle を確認できていません", courseId: 0, course: "kadai-sentinel",
           title, url: "", fields: [["対処", how]], urgent: true };
}

const alive = (p: Pending, now: number) => now - p.at <= PENDING_TTL && !(p.notice.until && now >= p.notice.until);

/** 送れなかったものだけを返す。急ぎは1件ずつ(4件以上ならまとめて)、それ以外はまとめて送るので、一部だけ失敗しても二重送信しない。
 *  Discord が内容を受け付けない失敗(4xx)は、1件ずつ → 埋め込みなしの文字だけ、と形を変えて送り、それでもだめなら捨てる
 *  (同じ失敗を送り直し続けない) */
async function deliver(url: string, items: Pending[]): Promise<Pending[]> {
  const left: Pending[] = [];
  const attempt = async (group: Pending[]): Promise<void> => {
    try { await send(url, group.map((p) => p.notice)); return; }
    catch (e) {
      if (!(e instanceof DiscordError && e.permanent)) { console.log(`送信失敗(送り直します): ${e}`); left.push(...group); return; }
      console.log(`Discord が受け付けませんでした(形を変えて送ります): ${e}`);
    }
    if (group.length > 1) { for (const p of group) await attempt([p]); return; }
    try { await sendPlain(url, group[0].notice); }
    catch (e) {
      if (e instanceof DiscordError && e.permanent) console.log(`送れないため破棄: ${group[0].notice.title} ${e}`);
      else left.push(...group);
    }
  };
  const urgent = items.filter((p) => p.notice.urgent);
  if (urgent.length > 3) await attempt(urgent); else for (const p of urgent) await attempt([p]);
  const normal = items.filter((p) => !p.notice.urgent);
  if (normal.length) await attempt(normal);
  return left;
}

/**
 * 前回送れなかったもの+今回の新しい通知を送り、送れなかったものを state.pending に残す。
 * 先に「これから送るもの」として保存してから送る。保存に失敗したら何も送らない
 * (保存できないまま送ると、次の起動でも同じ通知を送り続けてしまうため)。
 */
async function flush(env: Env, state: State, now: number, fresh: Record<Channel, Notice[]>) {
  const urls: Record<Channel, string | undefined> = { shared: env.DISCORD_WEBHOOK_URL, personal: env.PERSONAL_WEBHOOK_URL };
  const pending = (state.pending ??= {});
  const items: Record<Channel, Pending[]> = { shared: [], personal: [] };
  for (const ch of ["shared", "personal"] as Channel[]) {
    const keep = fresh[ch].filter((n) => !muted(rules, ch, n));      // [[mute]] で消したもの
    if (keep.length < fresh[ch].length) console.log(`[${ch}] ミュートで ${fresh[ch].length - keep.length} 件を送りませんでした`);
    fresh[ch] = keep;
    items[ch] = urls[ch] ? (pending[ch] ?? []).filter((p) => alive(p, now))
      .concat(fresh[ch].map((notice) => ({ at: now, notice }))) : [];
    pending[ch] = items[ch];
  }
  const total = items.shared.length + items.personal.length;
  if (total) {
    state.retry_at = now + LOCK;                     // 送っている途中で止まっても、5分後に送り直しが始まる
    await env.STATE.put("state", JSON.stringify(state));
  }
  for (const ch of ["shared", "personal"] as Channel[]) {     // 共有(友達向け)が先
    for (const p of items[ch]) console.log(`[${ch === "shared" ? "共有" : "個人"}] ${p.notice.heading} | ${p.notice.course} / ${p.notice.title}`);
    pending[ch] = items[ch].length ? (await deliver(urls[ch] as string, items[ch])).slice(-PENDING_KEEP) : [];
  }
  const left = [...(pending.shared ?? []), ...(pending.personal ?? [])];
  // 送り直しの間隔は、失敗が長引くほど空ける(5分 → … → 最大1時間)。急ぎは最初の30分だけ1分おき
  const hurry = left.some((p) => p.notice.urgent && now - p.at < URGENT_FAST_RETRY);
  const age = left.length ? now - Math.min(...left.map((p) => p.at)) : 0;
  if (left.length) state.retry_at = now + (hurry ? 60 : Math.min(3600, Math.max(PENDING_RETRY, Math.floor(age / 4))));
  else delete state.retry_at;
  return left.length;
}

async function configAlert(env: Env, now: number): Promise<never> {
  const st = (await env.STATE.get<State>("state", "json")) ?? { shared: {}, personal: {} };
  if (env.PERSONAL_WEBHOOK_URL && now - (st.last_config_alert ?? 0) >= 86400) {
    st.last_config_alert = now;
    await env.STATE.put("state", JSON.stringify(st));          // 先に記録してから送る(繰り返さない)
    await send(env.PERSONAL_WEBHOOK_URL, [{
      heading: "⚠️ notify.toml に誤りがあり、通知が止まっています", courseId: 0, course: "kadai-sentinel",
      title: (configError ?? "").slice(0, 200), url: "",
      fields: [["対処", "notify.toml を直して、もう一度 npx wrangler deploy"]], urgent: true }]).catch(() => {});
  }
  throw new Error(`notify.toml の誤り: ${configError}`);
}

async function run(env: Env, force = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (configError) return configAlert(env, now);
  const saved = await env.STATE.get<State>("state", "json");
  if (saved && !force && now < (saved.next_at ?? 0)) {
    // Moodle を確認する時刻ではないが、送り直しの時刻なら Discord にだけ送り直す
    if (!saved.retry_at || now < saved.retry_at) return "skip";
    const waiting = await flush(env, saved, now, { shared: [], personal: [] });
    await env.STATE.put("state", JSON.stringify(saved));
    return `送り直し: 残り ${waiting} 件`;
  }

  const first = saved === null;
  const state: State = saved ?? { shared: {}, personal: {} };
  // 確認中(Moodle が遅いときなど)に次の起動が同じ確認を始めて二重送信しないよう、先に印をつける
  if (saved) await env.STATE.put("state", JSON.stringify({ ...saved, next_at: now + LOCK, retry_at: now + LOCK }));
  const m = new Moodle(env.MOODLE_URL, env.MOODLE_TOKEN);

  // ---- Moodle の確認(ここで失敗したら、状態は何も変えずに失敗として記録する)
  let acts: Activity[], tasks: Task[];
  try {
    const ids = sharedIds(rules);
    const names = ids.length ? await listCourses(m) : new Map<number, string>();
    const genericIds = ids.filter((id) => courseRule(rules, id).kinds.some((k) => k !== "小テスト" && k !== "課題"));
    acts = await fetchActivities(m, ids, names);
    acts = acts.concat(await fetchGeneric(m, genericIds, names, now));
    acts = acts.concat(manualActivities(rules, acts));
    tasks = await fetchTodo(m, now);
  } catch (e) {
    if (first) throw e;
    const tokenErr = e instanceof MoodleError && ["invalidtoken", "accessexception"].includes(e.errorcode ?? "");
    state.fail_since ??= now;
    // トークン切れはすぐ、それ以外(大学のサーバーの停止など)は失敗が6時間続いたら、24時間に1回だけ自分に知らせる
    const stale = !tokenErr && now - state.fail_since >= STALE_ALERT;
    if ((tokenErr || stale) && now - (state.last_alert_at ?? 0) >= 86400 && env.PERSONAL_WEBHOOK_URL) {
      // 先に「送った」と保存してから送る(保存できない状態で警告を繰り返さない)。送れなかったら記録を戻す
      const prev = state.last_alert_at;
      state.last_alert_at = now;
      state.next_at = now + (tokenErr ? 3600 : 300);
      await env.STATE.put("state", JSON.stringify(state));
      const n = tokenErr
        ? alert("トークンが無効になった可能性があります", "PC で uv run moodle login --sso → worker で npm run secrets")
        : alert(`${Math.floor((now - state.fail_since) / 3600)}時間、確認に失敗し続けています(${String(e).slice(0, 120)})`,
                "大学の Moodle が止まっていないか確認。直らなければ Claude に相談");
      try { await send(env.PERSONAL_WEBHOOK_URL, [n]); }
      catch { if (prev === undefined) delete state.last_alert_at; else state.last_alert_at = prev; }   // 次の確認でもう一度
    }
    // 5分後にもう一度。トークン切れはすぐ直らないので1時間あける(大学のサーバーを叩き続けない)
    state.next_at = now + (tokenErr ? 3600 : 300);
    await env.STATE.put("state", JSON.stringify(state));
    throw e;
  }

  // ---- オンライン授業・お知らせ(約3時間に1回だけ取る。失敗しても、ほかの通知は止めない)
  const extra: Notice[] = [];
  if (!first && now - (state.extras_at ?? 0) >= EXTRAS_EVERY) {
    try {
      const names = await listCourses(m);
      const ids = [...names.keys()].filter((id) => !rules.personalExclude.has(id));
      if (rules.online.enabled) {
        const [urls, att] = [await fetchUrls(m, ids), await fetchAttendance(m, ids, now)];
        extra.push(...refreshOnline(rules, urls, att, names, state, now, m.base));
      }
      if (rules.news.mode !== "off") {
        const others = ids.filter((id) => !rules.courses.get(id)?.enabled);   // 共有チャンネルにない授業
        extra.push(...planNews(rules, await fetchNews(m, others), names, state, now, m.base));
      }
      state.extras_at = now;
    } catch (e) {
      console.log(`オンライン授業・お知らせの取得に失敗(約1時間後にもう一度): ${e}`);
      state.extras_at = now - EXTRAS_EVERY + 3600;
    }
  }
  extra.push(...planOnlineToday(rules, state, now));

  // ---- 通知を決めて送る(Discord の失敗は Moodle の失敗と分けて扱い、送れなかった分は送り直す)
  const shared = planShared(acts, state, rules, now, first).concat(first ? [] : planMorning(acts, state, rules, now))
    .concat(extra.filter((n) => n.channel === "shared"));
  // 転送する締切リマインドのうち、やること一覧に無いものは、本当に提出済みかを Moodle に確かめる(分からなければ送る)
  const submitted = new Set<string>();
  for (const id of needsSubmitCheck(shared, tasks, rules)) if (await isSubmitted(m, id)) submitted.add(id);
  const personal = mirrorShared(shared, submitted, rules).concat(planPersonal(tasks, state, rules, now, first))
    .concat(extra.filter((n) => n.channel !== "shared"));
  state.last_ok = now;
  delete state.fail_since;
  state.next_at = now + LOCK;                        // 送っている途中に次の確認が始まらないように
  const waiting = await flush(env, state, now, { shared, personal });
  state.next_at = nextRunAt(rules, acts, tasks, Math.floor(Date.now() / 1000));
  await env.STATE.put("state", JSON.stringify(state));
  return `${first ? "初回: 状態を記録しました。" : ""}共有 ${shared.length} / 個人 ${personal.length} 件`
       + `${waiting ? `(送れなかった ${waiting} 件は送り直します)` : ""}。次の確認 ${fmtTime(state.next_at)}`;
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
