// ============================================================
// Vercel AI SDK model execution — OpenCode invocation projection
// ============================================================

import { stat } from "node:fs/promises";
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import { getCurrentModelInvocationContext } from "@zcode/contracts";
import {
  isOpenCodeFreeUsageLimitMessage,
  readOpenCodeRequestDiagnostic,
  readOriginalErrorTail,
} from "../failure-inspection.js";
import type { OpenCodeTaskBridge } from "../opencode-session.js";

const OPENCODE_AGENT_LIST_HEADINGS = [
  "Available named agent types for Agent/Task tools:",
  "New named agent types are now available for Agent/Task tools:",
] as const;
const OPENCODE_AGENT_PROFILE_GUIDANCE = "Available ZCode agent profiles for the zcode_task tool";

/**
 * OpenCode 执行自己的工具，不能接收 ZCode 的 Agent/Skill 工具协议。
 * 只投影发送给 OpenCode 的副本，避免把协议不兼容写回 canonical conversation history。
 */
export function projectOpenCodePrompt(
  prompt: LanguageModelV3Prompt,
  zcodeTaskEnabled = false,
  zcodeSkillEnabled = false,
): LanguageModelV3Prompt {
  return prompt.map((message) => {
    if (message.role === "system") {
      return {
        ...message,
        content: projectOpenCodePromptText(message.content, zcodeTaskEnabled, zcodeSkillEnabled),
      };
    }
    // 原因：历史 assistant/tool 内容是对话记录，不是协议指令；修复依据：只投影运行时 system 和 user 指令。
    if (message.role !== "user") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "text") return part;
      const projected = projectOpenCodePromptText(part.text, zcodeTaskEnabled, zcodeSkillEnabled);
      if (projected === part.text) return part;
      changed = true;
      return { ...part, text: projected };
    });
    return changed ? { ...message, content } : message;
  });
}

function projectOpenCodePromptText(
  value: string,
  zcodeTaskEnabled: boolean,
  zcodeSkillEnabled: boolean,
): string {
  let text = value;
  if (zcodeSkillEnabled) {
    text = text.replace(
      "The following skills are available for use with the Skill tool:",
      "The following ZCode skills are available. Load one by calling `zcode_skill` with its exact skill name; do not read skill paths directly.",
    );
  } else {
    text = text.replace(
      "The following skills are available for use with the Skill tool:",
      "The following ZCode skills are listed for reference, but this request cannot load them because the ZCode Skill capability is unavailable. Do not read skill paths directly.",
    );
  }
  // Paths are private implementation details of SkillPort; OpenCode must request a skill by name.
  text = text.replace(/\s+\(file: [^)]+\)/gu, "");

  if (zcodeTaskEnabled) {
    text = text
      .replace(/delegate them with Agent\./gu, "delegate them with the `zcode_task` tool.")
      .replace(
        /Use only agent types listed in the current Agent system-reminder,/gu,
        "Use the `zcode_task` tool and set `subagent_type` to an exact active ZCode profile ID from the following roster; preserve its role instructions and do not use OpenCode's native `task` tool for ZCode delegation.",
      );
  } else {
    text = text
      .replace(
        /For complex tasks, delegate them with Agent\./gu,
        "For this request, answer directly because ZCode agent delegation is unavailable.",
      )
      .replace(
        /Use only agent types listed in the current Agent system-reminder,/gu,
        "ZCode delegation is unavailable for this request; answer directly instead of using OpenCode's native `task` tool.",
      );
  }

  for (const heading of OPENCODE_AGENT_LIST_HEADINGS) {
    if (!text.includes(heading)) continue;
    text = text.replace(heading, `${OPENCODE_AGENT_PROFILE_GUIDANCE}:`);
  }
  if (text.includes("The following agent types are no longer available:")) {
    text = text.replace(
      "The following agent types are no longer available:",
      "The following ZCode agent profiles are no longer available:",
    );
  }
  // Причина: профильный roster сериализуется Core с capability Agent/Task, но OpenCode видит только
  // invocation-local zcode_task. Если оставить исходные имена, модель выбирает несуществующий tool.
  // Основание: сохранить одну роль и один owner Core, показывая provider-specific alias только в prompt-копии.
  text = text.replace(/\s+\(Tools: ([^\n)]*)\)/gu, (_match, rawTools: string) => {
    const projectedTools = rawTools
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0)
      .flatMap((tool) => {
        if (tool !== "Agent" && tool !== "Task") return [tool];
        return zcodeTaskEnabled ? ["zcode_task"] : [];
      });
    const uniqueTools = [...new Set(projectedTools)];
    return uniqueTools.length > 0 ? ` (Tools: ${uniqueTools.join(", ")})` : "";
  });
  return text;
}

export function sanitizeOpenCodeEmptyResponseError(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.includes("OpenCode returned no response data")) {
    return error;
  }

  const diagnostic = readOpenCodeRequestDiagnostic(error);
  const originalTail = readOriginalErrorTail(error.message);
  // 原因：SDK 把 “Free usage limit reached” 只拼在 Original error 尾部。
  // 整段替换后分类器看不到限额，UI 就显示空响应。只保留这句限额或精确的 fetch failed。
  const quotaMessage =
    diagnostic?.message === undefined &&
    originalTail &&
    isOpenCodeFreeUsageLimitMessage(originalTail)
      ? originalTail.slice(0, 280)
      : undefined;
  const retainedDiagnostic = diagnostic ?? (quotaMessage ? { message: quotaMessage } : undefined);
  const diagnosticSuffix = retainedDiagnostic
    ? ` OpenCode request diagnostic: ${JSON.stringify(retainedDiagnostic)}`
    : "";
  // 根因：SDK 的空响应文案会把通用服务器错误猜成无效模型 ID，随后原样出现在 UI 详情中。
  // 修复依据：只保留诊断 fetch 已脱敏的状态/错误字段；不保留原始 SDK Error 或 cause。
  const safeError = new Error(
    `OpenCode returned an empty response.${diagnosticSuffix}`,
  ) as Error & {
    code: string;
    statusCode?: number;
    isRetryable: false;
  };
  safeError.name = "OpenCodeEmptyResponseError";
  safeError.code = "OPENCODE_EMPTY_RESPONSE";
  if (diagnostic?.statusCode !== undefined) safeError.statusCode = diagnostic.statusCode;
  const transportTail = originalTail?.trim().toLowerCase();
  if (transportTail === "fetch failed" || transportTail === "failed to fetch") {
    safeError.cause = new TypeError(transportTail);
  }
  safeError.isRetryable = false;
  return safeError;
}

export function sanitizeOpenCodeStreamErrors(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): ReadableStream<LanguageModelV3StreamPart> {
  const reader = stream.getReader();
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        const part = result.value;
        if (part.type === "error") {
          // 根因：OpenCode SDK 会把 HTTP 失败作为 `type: error` 数据块返回，而不是 reject stream；
          // 原先只净化 reader.read() 的异常，导致聊天路径丢失安全诊断并把空响应暴露给分类器。
          // 修复依据：同一安全转换覆盖流内 error part，保留经脱敏的状态/错误消息供 UI 分类。
          controller.enqueue({ ...part, error: sanitizeOpenCodeEmptyResponseError(part.error) });
          return;
        }
        controller.enqueue(part);
      } catch (error) {
        controller.error(sanitizeOpenCodeEmptyResponseError(error));
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function disposeAfterStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  dispose: () => Promise<void>,
): ReadableStream<LanguageModelV3StreamPart> {
  const reader = stream.getReader();
  let cleanup: Promise<void> | undefined;
  const release = () => {
    cleanup ??= dispose().catch(() => undefined);
    return cleanup;
  };
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          await release();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        reader.releaseLock();
        await release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        await release();
      }
    },
  });
}

const OPENCODE_WORKSPACE_DIRECTORY_ERROR =
  "OpenCode needs an available workspace folder. Reopen or restore the workspace, then try again.";
const OPENCODE_WORKSPACE_UNAVAILABLE_CODE = "OPENCODE_WORKSPACE_UNAVAILABLE";

function createOpenCodeWorkspaceUnavailableError(): Error & { code: string } {
  const error = new Error(OPENCODE_WORKSPACE_DIRECTORY_ERROR) as Error & { code: string };
  error.code = OPENCODE_WORKSPACE_UNAVAILABLE_CODE;
  return error;
}

export async function assertOpenCodeWorkspaceDirectory(
  directory: string | undefined,
): Promise<void> {
  if (!directory) throw createOpenCodeWorkspaceUnavailableError();

  try {
    if (!(await stat(directory)).isDirectory()) {
      throw createOpenCodeWorkspaceUnavailableError();
    }
  } catch {
    // Не отдаём путь или детали файловой системы: каталог workspace может быть удалён между сессиями.
    throw createOpenCodeWorkspaceUnavailableError();
  }
}

export interface OpenCodeInvocationProvider extends OpencodeProvider {
  createInvocationModel?(
    modelId: string,
    settings: { directory?: string },
    bridge: OpenCodeTaskBridge,
  ): Promise<{ model: ReturnType<OpencodeProvider>; dispose(): Promise<void> }>;
}

export type ExecuteOpenCodeTask = NonNullable<
  ReturnType<typeof getCurrentModelInvocationContext>
>["executeOpenCodeTask"];

export type ExecuteOpenCodeSkill = NonNullable<
  ReturnType<typeof getCurrentModelInvocationContext>
>["executeOpenCodeSkill"];

export function getOpenCodeTaskExecutor(): ExecuteOpenCodeTask | undefined {
  return getCurrentModelInvocationContext()?.executeOpenCodeTask;
}

export function getOpenCodeSkillExecutor(): ExecuteOpenCodeSkill | undefined {
  return getCurrentModelInvocationContext()?.executeOpenCodeSkill;
}

// Nested ZCode tasks can hold one OpenCode MCP call while descendants run. Keep
// this much longer than the child inactivity watchdog; that watchdog and abort
// signal own stalled-task cancellation, while the MCP timeout is only a ceiling.
export const OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
