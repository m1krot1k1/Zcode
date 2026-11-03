import { describe, expect, it } from "vitest";
import { resolveChatErrorBannerDisplayMessage } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { sanitizeErrorDetailForUser } from "@/lib/sanitizeErrorDetail.js";

function createIntl(messages: Record<string, string>): IntlInstance {
  return {
    formatMessage({ id }, values = {}) {
      const template = messages[id] ?? id;
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    },
  };
}

const enIntl = createIntl(enUS);
const zhIntl = createIntl(zhCN);

describe("resolveChatErrorBannerDisplayMessage — run budget exhausted", () => {
  it.each([
    [
      "Run stopped: run resource budget exhausted",
      "Root run resource budget exhausted (session_x:turn_y)",
    ],
    ["Run stopped: token budget exhausted", "Root run token budget is exhausted"],
    ["Run stopped: time budget exhausted", "Root run time budget exhausted"],
  ] as const)("本地化 %s（attribution 已结构化）", (expected, raw) => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "RUN_FAILED",
          message: raw,
          attribution: { reason: "run_budget_exhausted" },
        },
        enIntl,
      ),
    ).toBe(expected);
  });

  it("attribution 命中但文案被改写时按资源预算兜底", () => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "RUN_FAILED",
          message: "Run failed: budget limit reached",
          attribution: { reason: "run_budget_exhausted" },
        },
        zhIntl,
      ),
    ).toBe("已停止：运行资源预算耗尽");
  });

  it("没有 attribution 时靠稳定文案识别，不把内部原文丢给用户", () => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "UNKNOWN", message: "Root run token budget is exhausted" },
        zhIntl,
      ),
    ).toBe("已停止：token 预算耗尽");
  });

  it("只有 detail 携带文案时也能识别", () => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "UNKNOWN",
          message: "Agent run failed",
          detail: "reason=Root run time budget exhausted",
        },
        enIntl,
      ),
    ).toBe("Run stopped: time budget exhausted");
  });

  it("普通错误保持原有行为", () => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "UNKNOWN", message: "Something else broke" },
        enIntl,
      ),
    ).toBe("Something else broke");
  });
});

describe("sanitizeErrorDetailForUser", () => {
  it("去掉 session/turn 内部标识与 UUID，保留其余文本", () => {
    expect(
      sanitizeErrorDetailForUser(
        "reason=Root run resource budget exhausted session_abc123:turn_def-1 provider_code=1102 id=9f8b1c2d-3e4f-4a5b-8c6d-7e8f90a1b2c3 done",
      ),
    ).toBe("reason=Root run resource budget exhausted <turn> provider_code=1102 id=<id> done");
  });

  it("清理多处标识并保留换行结构", () => {
    expect(
      sanitizeErrorDetailForUser(
        "line1 session_a:turn_b\nline2 c30b4a4e-1111-4222-8333-444455556666 session_c:turn_d",
      ),
    ).toBe("line1 <turn>\nline2 <id> <turn>");
  });

  it("空值不抛异常", () => {
    expect(sanitizeErrorDetailForUser(undefined)).toBe("");
    expect(sanitizeErrorDetailForUser("")).toBe("");
  });

  it("没有可替换内容时原样返回", () => {
    expect(sanitizeErrorDetailForUser("Net::ERR_CONNECTION_RESET")).toBe(
      "Net::ERR_CONNECTION_RESET",
    );
  });
});
