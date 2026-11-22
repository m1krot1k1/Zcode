/**
 * 日志行只带时分秒；把它折回挂载当天的绝对时间，供阶段耗时面板使用。
 * 展示时钟可能落后新日志不到一秒；只有明显跨日才回退，不能把新日志误判为昨天。
 */
export function resolveRemoteConnectionLogTime(timestamp: string, fallback: number): number {
  const parts = String(timestamp).match(/(\d{1,2}):(\d{2}):(\d{2})/u);
  if (!parts) return fallback;
  const wallNow = Date.now();
  const date = new Date(wallNow);
  date.setHours(Number(parts[1]), Number(parts[2]), Number(parts[3]), 0);
  if (date.getTime() - wallNow > 12 * 60 * 60 * 1000) date.setDate(date.getDate() - 1);
  return date.getTime();
}
