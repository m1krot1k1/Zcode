/** 共享的 JSON/配置对象类型守卫。 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
