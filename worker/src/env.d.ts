interface KVNamespace {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}
interface ScheduledController { scheduledTime: number; cron: string }
