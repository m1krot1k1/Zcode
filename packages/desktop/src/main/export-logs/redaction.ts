// 敏感内容脱敏：导出日志不能按文件原样拷贝，否则会把用户配置和协议日志里的
// token/apiKey 一并带出。这里只做“值”的替换，键名与日志行结构保持不变。
const REDACTED_PLACEHOLDER = "***REDACTED***";
// 敏感键名“族”：只要键名里包含这些子串就视为敏感（兜底通配），
// 从而覆盖自定义命名（如 db_password、my_secret、x-conn-string 等）而不必逐个精确列举。
// 注意：`token` / `auth` 等是宽松子串，配合下方白名单排除误伤项（如 input_tokens、author）。
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// 白名单：命中敏感子串但实际并非密钥的常见键名，避免脱掉排障需要的上下文。
// 不能把任意 "*_tokens" 都白名单化，否则 access_tokens/session_tokens 会被原样导出；
// max_tokens/budget_tokens 是模型输出与思考预算，不是凭据，需保留用于判断 provider 请求是否撞限；
// 因此这里只放行明确的 LLM token 计数/预算字段，以及 author/authority 这类含 "auth" 的普通词。
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX =
  /^(?:public(?:_|-)?key|keywords?|tokenizer|token(?:_|-)?count|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|accepted(?:_|-)?prediction|rejected(?:_|-)?prediction|tool(?:_|-)?use(?:_|-)?prompt)(?:_|-)?tokens|author(?:s|ity|ed)?)$/i;

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// 以下正则先宽松捕获“键名 + 值”，再由 isSensitiveKeyName 决定是否脱敏，
// 这样键名黑名单不再是硬编码列表，而是“敏感族 + 通配 + 白名单例外”。
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// 按“值形态”脱敏：连接串 scheme://user:pass@host 里的凭据部分，
// 不依赖键名即可覆盖 postgres/mysql/mongodb/redis/amqp 等数据库连接信息。保留 scheme 与 host 便于排障。
// 用户名段允许为空以覆盖 redis://:password@host；口令段贪婪匹配到最后一个 @（host 段不含 @），
// 这样口令里含裸 @（如 P@ssw0rd）也能整段脱敏，不残留片段。
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;

function redactValue(rawValue: string): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

export function sanitizeSensitiveLogContent(rawContent: string): string {
  // 导出日志不能按文件原样拷贝：会把用户配置和协议日志里的 token/apiKey 一并带出。
  // 线上排障需要“保留文件结构和上下文”，但不应该泄露密钥本体；
  // 这里在导出阶段统一对常见敏感值做脱敏，字段和日志行仍完整保留，支持继续定位问题。
  // 键名不再是硬编码黑名单，而是“敏感键名族 + 子串通配 + 白名单例外”（isSensitiveKeyName），
  // 并叠加按值形态的连接串脱敏，以覆盖数据库连接串等自定义命名的敏感信息。
  return redactConnectionStringCredentials(rawContent)
    .replace(
      JSON_STYLE_SENSITIVE_VALUE_REGEX,
      (match, quote: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${quote}${keyName}${quote}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}
