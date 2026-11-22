import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_V4_ATTACHMENT,
  TID_V4_COMPOSER_INPUT,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared/test-ids";
import { dispatchMouseDownByExactTestId } from "../desktop-app.js";

// ── M5 composer 工具条 / slash 面板 ──

/** 读取 composer 附件卡片的可观察文件名与 ready 状态。 */
export function getV4ComposerAttachments(): Promise<
  Array<{ text: string; uploadStatus: string | null }>
> {
  return browser.execute(
    (attachmentPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${attachmentPrefix}-"]`))
        .filter((element) => element.hasAttribute("data-upload-status"))
        .map((element) => {
          // Bug 原因：媒体卡片按产品设计只展示缩略图，文件名在 img alt 中；读取
          // innerText 会把 ready 的图片误判成“附件没有进入 ready”。
          const mediaFilename = element.querySelector<HTMLImageElement>("img[alt]")?.alt.trim();
          return {
            text: mediaFilename || (element.innerText || element.textContent || "").trim(),
            uploadStatus: element.getAttribute("data-upload-status"),
          };
        }),
    TID_V4_ATTACHMENT,
  );
}

/** slash 候选面板是否出现。 */
export function hasV4SlashPanel(): Promise<boolean> {
  return browser.execute(
    (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
    TID_PROMPT_SUGGESTION_PANEL,
  );
}

/** 读取 slash 面板当前候选项 id（如 "slash:compact"）。 */
export function getV4SlashOptionIds(): Promise<string[]> {
  return browser.execute((optionPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`),
    ).map((element) => element.getAttribute("data-option-id") ?? "");
  }, TID_PROMPT_SUGGESTION_OPTION);
}

/** 等待 slash 面板出现且包含目标候选项。 */
export async function waitForV4SlashOption(optionId: string, timeout = 15000) {
  await browser.waitUntil(
    async () => (await hasV4SlashPanel()) && (await getV4SlashOptionIds()).includes(optionId),
    {
      timeout,
      timeoutMsg: `slash 面板没有出现候选项: ${optionId}`,
    },
  );
}

/**
 * 点选 slash 候选项。面板选项在 mousedown 上确认（preventDefault 防 blur），
 * element.click() 不派发 mousedown，这里显式 dispatch。
 */
export async function clickV4SlashOption(optionId: string) {
  const optionTestId = testId(TID_PROMPT_SUGGESTION_OPTION, optionId);
  let dispatched = false;
  await browser.waitUntil(
    async () => {
      // Bug 根因：Windows Skill option id 含反斜杠，动态 CSS selector 无法精确命中；
      // 同时 React 可能在候选加载时重挂载节点，所以定位与 mousedown 必须在一次查询内重试。
      dispatched = await browser.execute(dispatchMouseDownByExactTestId, optionTestId);
      return dispatched;
    },
    {
      timeout: 15000,
      timeoutMsg: `slash 面板候选项不可点击: ${optionId}`,
    },
  );
  return dispatched;
}

// ── M5 composer mention（@/#/$）/ 附件 ──
// mention 面板与 slash 面板共用 TID_PROMPT_SUGGESTION_PANEL / _OPTION 契约，
// 故读取/点选原语与 slash 同源；option-id 前缀区分（file:/session:/skill:）。

/**
 * 等待 mention 面板出现且含以 prefix 打头的候选项（如 "session:"）。
 * 返回首个命中的完整 option-id。
 */
export async function waitForV4MentionOptionPrefix(
  prefix: string,
  timeout = 15000,
): Promise<string> {
  let matched: string | undefined;
  await browser.waitUntil(
    async () => {
      if (!(await hasV4SlashPanel())) return false;
      matched = (await getV4SlashOptionIds()).find((id) => id.startsWith(prefix));
      return Boolean(matched);
    },
    {
      timeout,
      timeoutMsg: `mention 面板没有出现以 "${prefix}" 打头的候选项`,
    },
  );
  return matched as string;
}

/** 经真实 paste 事件向 v4 composer 加入一个 File，并走既有 eager upload。 */
export async function pasteV4ComposerFileAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  const pasted = await browser.execute(
    (inputTestId, fileName, explicitBase64, explicitPngBase64, explicitMimeType) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const editable =
        input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        (input?.getAttribute("contenteditable") === "true" ? input : null);
      if (!editable) return false;
      // 修复原因：旧 fixture 虽能被 file 识别为 PNG，但 production Jimp 会拒绝其尾部数据；
      // 使用已通过同一解码器验证的 1×1 PNG，避免图片 E2E 在业务读取前退化为占位文本。
      const imageBase64 =
        explicitBase64 ??
        explicitPngBase64 ??
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
      const binary = atob(imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: explicitMimeType ?? "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      editable.focus();
      editable.dispatchEvent(pasteEvent);
      return true;
    },
    TID_V4_COMPOSER_INPUT,
    filename,
    options.base64,
    options.pngBase64,
    options.mimeType,
  );
  if (!pasted) {
    throw new Error("v4 composer 输入框没有出现，无法派发粘贴事件");
  }
  return filename;
}

/** 向 v4 composer 派发图片文件；保留既有 case 的语义化入口。 */
export function pasteV4ComposerImageAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  return pasteV4ComposerFileAttachment(filename, options);
}

/** 等待某个 user 行渲染出附件簇，返回文件 pill 文本及媒体缩略图的可访问文件名。 */
export async function waitForV4RowAttachments(
  timeout = 60000,
  expectedNames: readonly string[] = [],
): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = await browser.execute((attachmentsPrefix) => {
        const el = document.querySelector<HTMLElement>(`[data-testid^="${attachmentsPrefix}-"]`);
        if (!el) return "";
        // Bug 原因：已发送媒体只有缩略图，文件名由 img alt 承载，不能用 innerText
        // 是否为空来判断附件簇有没有渲染。
        const visibleText = (el.innerText ?? "").trim();
        const mediaFilenames = Array.from(el.querySelectorAll<HTMLImageElement>("img[alt]"))
          .map((image) => image.alt.trim())
          .filter(Boolean);
        return [visibleText, ...mediaFilenames].filter(Boolean).join("\n");
      }, TID_V4_ROW_ATTACHMENTS);
      // 文本卡和媒体缩略图异步挂载；需要整组附件的 case 不能把第一张卡当作全组就绪。
      return text.trim().length > 0 && expectedNames.every((name) => text.includes(name));
    },
    { timeout, timeoutMsg: "user 行没有渲染出附件簇（TID_V4_ROW_ATTACHMENTS）" },
  );
  return text;
}
