/**
 * 错误详情脱敏 —— 展示给用户的报错详情不能带内部 id。
 *
 * 背景：`formatContextDetail` 会把 `reason=<raw>` 拼进 `error.detail`，
 * 其中可能包含 `session_x:turn_y` 这类内部运行标识和原始 UUID。
 * 这些标识对用户没有任何信息价值，还会在复制/反馈时外泄，因此在展示层统一替换。
 * 注意：只处理面向用户的详情，诊断用的 underlyingErrorDetail 保持原样。
 */

const SESSION_TURN_ID_PATTERN = /session_[A-Za-z0-9_-]+:turn_[A-Za-z0-9_-]+/g;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function sanitizeErrorDetailForUser(text: string | undefined | null): string {
  if (!text) {
    return "";
  }

  return text.replace(SESSION_TURN_ID_PATTERN, "<turn>").replace(UUID_PATTERN, "<id>");
}
