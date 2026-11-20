/**
 * ui-lexical-chat-input 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { LexicalChatInputHandle } from "./contract.js";

export function exampleUiLexicalChatInput(input: LexicalChatInputHandle | null): string {
  return input?.getText() ?? "";
}
