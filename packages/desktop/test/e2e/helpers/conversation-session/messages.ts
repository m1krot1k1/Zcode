import {
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_MESSAGES,
  TID_CHAT_USER_MESSAGE,
  TID_V4_TIMELINE,
} from "@zcode/shared/test-ids";
import { getQueueItems as readQueueItemsForDiagnostics } from "../conversation-session-queue.js";
import { getTaskStoreSnapshot as readTaskStoreSnapshotForDiagnostics } from "../conversation-session-store.js";
import { getChatRootSnapshot } from "./chat-root.js";
import { getComposerText } from "./composer.js";

export interface MessageSnapshot {
  id: string | null;
  role: string | null;
  text: string;
}

export async function waitForAssistantMessageContaining(text: string) {
  await browser.waitUntil(
    async () => (await getMessages("assistant")).some((message) => message.text.includes(text)),
    {
      timeout: 90000,
      timeoutMsg: `assistant 消息中没有出现: ${text}`,
    },
  );
}

export async function waitForUserMessageContaining(text: string) {
  let latestMessages: MessageSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestMessages = await getMessages("user");
        return latestMessages.some((message) => message.text.includes(text));
      },
      {
        timeout: 60000,
        timeoutMsg: `user 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    // 修复原因：CI 上 conversation case 失败时，单看 DOM 消息列表无法判断
    // 输入是被 renderer 队列拦住，还是 slash command 没解析。失败信息直接带状态快照。
    const chat = await getChatRootSnapshot().catch((snapshotError) => ({
      error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    }));
    const queue = await readQueueItemsForDiagnostics().catch((queueError) => [
      {
        content: queueError instanceof Error ? queueError.message : String(queueError),
        id: "<queue-read-error>",
        index: -1,
        kind: null,
        status: null,
      },
    ]);
    const taskStore =
      "taskId" in chat && chat.taskId
        ? await readTaskStoreSnapshotForDiagnostics(chat.taskId).catch((storeError) => ({
            error: storeError instanceof Error ? storeError.message : String(storeError),
          }))
        : null;
    const composer = await getComposerText().catch((composerError) =>
      composerError instanceof Error ? composerError.message : String(composerError),
    );
    throw new Error(
      `user 消息中没有出现: ${text}; latestMessages=${JSON.stringify(latestMessages)}; chat=${JSON.stringify(chat)}; queue=${JSON.stringify(queue)}; taskStore=${JSON.stringify(taskStore)}; composer=${JSON.stringify(composer)}`,
      { cause: error },
    );
  }
}

export async function assertVisibleUserMessagesNotContaining(text: string) {
  const messages = await getMessages("user");
  expect(messages.map((message) => message.text).join("\n")).not.toContain(text);
}

export function getMessages(role?: "assistant" | "user"): Promise<MessageSnapshot[]> {
  return browser.execute(
    (
      messagesTestId: string,
      userPrefix: string,
      assistantPrefix: string,
      selectedRole: "assistant" | "user" | undefined,
      v4TimelineTestId: string,
    ) => {
      const legacyRoot = document.querySelector<HTMLElement>(`[data-testid="${messagesTestId}"]`);
      if (legacyRoot) {
        const selector =
          selectedRole === "user"
            ? `[data-testid^="${userPrefix}-"]`
            : selectedRole === "assistant"
              ? `[data-testid^="${assistantPrefix}-"]`
              : `[data-testid^="${userPrefix}-"],[data-testid^="${assistantPrefix}-"]`;
        return Array.from(legacyRoot.querySelectorAll<HTMLElement>(selector)).map((element) => ({
          id: element.getAttribute("data-message-id"),
          role: element.getAttribute("data-role"),
          text: element.innerText.replace(/\u00a0/g, " ").trim(),
        }));
      }

      const timeline = document.querySelector<HTMLElement>(`[data-testid="${v4TimelineTestId}"]`);
      return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .map((element) => {
          const role = element.classList.contains("group/user-row")
            ? "user"
            : element.classList.contains("group/assistant-row")
              ? "assistant"
              : null;
          return {
            id: element.getAttribute("data-row-id"),
            role,
            text: element.innerText.replace(/\u00a0/g, " ").trim(),
          };
        })
        .filter((message) => message.role && (!selectedRole || message.role === selectedRole));
    },
    TID_CHAT_MESSAGES,
    TID_CHAT_USER_MESSAGE,
    TID_CHAT_ASSISTANT_MESSAGE,
    role,
    TID_V4_TIMELINE,
  );
}
