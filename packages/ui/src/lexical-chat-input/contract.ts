/**
 * ui-lexical-chat-input 对外契约。
 *
 * Composer 的 imperative API 仍是唯一草稿写入入口。其它 UI 模块只能通过
 * `getActiveLexicalChatInput()` 取得当前焦点编辑器，不得直接创建第二份
 * Lexical 状态。
 */
export type { LexicalChatInputHandle } from "./types.js";
export { getActiveLexicalChatInput, setActiveLexicalChatInput } from "./activeInput.js";
