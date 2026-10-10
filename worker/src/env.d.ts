// wrangler が notify.toml を文字列として読み込む
declare module "*.toml" {
  const text: string;
  export default text;
}
interface KVNamespace {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}
interface ScheduledController { scheduledTime: number; cron: string }
