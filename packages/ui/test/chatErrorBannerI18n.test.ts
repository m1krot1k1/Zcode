import { describe, expect, it } from "vitest";
import {
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  OFF_PEAK_TICKET_EXPIRED_MARKER,
} from "@zcode/shared";
import { resolveChatErrorBannerDisplayMessage } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import ruRU from "@/i18n/locales/ru-RU.json" with { type: "json" };
import zhCN from "@/i18n/locales/zh-CN.js";

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

describe("ChatErrorBanner i18n", () => {
  it("uses the remote wording for an empty remote workspace instead of local plan copy", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);
    const error = {
      code: "model_config_missing",
      message: "Model config is missing",
    };

    const zhRemote = resolveChatErrorBannerDisplayMessage(error, zhIntl, "remote");
    const enRemote = resolveChatErrorBannerDisplayMessage(error, enIntl, "remote");

    expect(zhRemote).toBe(zhCN["chat.error.remoteNoAvailableModel"]);
    expect(zhRemote).not.toBe("chat.error.remoteNoAvailableModel");
    expect(zhRemote).not.toBe(zhCN["chat.error.noAvailableModel"]);
    expect(enRemote).toBe(enUS["chat.error.remoteNoAvailableModel"]);
    expect(enRemote).not.toBe("chat.error.remoteNoAvailableModel");
    expect(enRemote).not.toBe(enUS["chat.error.noAvailableModel"]);
    expect(resolveChatErrorBannerDisplayMessage(error, zhIntl, "local")).toBe(
      zhCN["chat.error.noAvailableModel"],
    );
  });

  it.each([
    [zhCN, "当前附件总量过大，请移除部分附件或压缩后重试。"],
    [
      enUS,
      "Current attachments are too large for one request. Remove or compress attachments and try again.",
    ],
  ] as const)("localizes the shared attachment budget error", (messages, expected) => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
          message: "Runtime fallback message",
        },
        createIntl(messages),
      ),
    ).toBe(expected);
  });

  it("localizes current media-budget attachment errors from stable runtime codes", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
          message:
            "Current video attachments are too large to send. Remove or shrink videos and try again.",
        },
        zhIntl,
      ),
    ).toBe("当前视频附件过大，请移除部分视频或压缩后重试。");

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
          message:
            "Current image attachments are too large to send. Remove or shrink images and try again.",
        },
        enIntl,
      ),
    ).toBe("Current image attachments are too large. Remove or compress images and try again.");
  });

  it("闲时票据不可用不展示上游原文（3102 与包装后的稳定标记都要本地化）", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);

    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "3102", message: "off peak ticket is invaliad or expired" },
        zhIntl,
      ),
    ).toBe("已超过单次最长运行时间，请创建新的闲时任务继续。");

    // 外层 code 被压成包装码时靠适配层写入的稳定标记兜底。
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "PROVIDER_BUSINESS_ERROR",
          message: `${OFF_PEAK_TICKET_EXPIRED_MARKER}: off peak ticket is invaliad or expired`,
        },
        enIntl,
      ),
    ).toBe(
      "This run exceeded the maximum single-run time. Create a new off-peak task to continue.",
    );
  });

  it.each([
    [
      "en-US",
      enUS,
      "This run reached the step limit and stopped. The answer so far is kept; send a follow-up message to continue.",
    ],
    [
      "ru-RU",
      ruRU,
      "Запуск достиг лимита шагов и остановился. Полученный ответ сохранён — отправьте следующее сообщение, чтобы продолжить.",
    ],
    ["zh-CN", zhCN, "本次运行已达到步数上限并提前结束。已生成的内容会保留，发送后续消息即可继续。"],
  ] as const)(
    "localizes error_max_turns for %s instead of exposing the raw runtime code",
    (_locale, messages, expected) => {
      // docs/specs/max-turns-limit.md MAXTURN-07：UI 必须显示明确的「达到步数上限」，
      // 且不能把 snake_case resultType 直接当作用户文案。
      const message = resolveChatErrorBannerDisplayMessage(
        { code: "error_max_turns", message: "Turn reached max turns" },
        createIntl(messages),
      );

      expect(message).toBe(expected);
      expect(message).not.toContain("error_max_turns");
      expect(message).not.toContain("zcode.error.ERROR_MAX_TURNS");
    },
  );
});
