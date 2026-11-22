/**
 * 输入框提交门禁与顿号归一判定。
 *
 * 纯函数，不依赖 Lexical / React，供 KeyboardPlugin 与单测直接引用。
 */
import type {
  LeadingChineseSlashAliasInputOptions,
  LexicalEnterSubmitOptions,
  LexicalModifiedEnterSubmitOptions,
  LexicalSubmitResult,
} from "@/lexical-chat-input/types.js";
import { CHINESE_SLASH_ALIAS } from "@/lexical-chat-input/constants.js";

export function shouldSubmitLexicalEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  enterSubmits,
  isComposing = false,
  metaKey = false,
  shiftKey = false,
  text,
}: LexicalEnterSubmitOptions): boolean {
  if (!enterSubmits) {
    return false;
  }
  if (shiftKey || ctrlKey || metaKey || isComposing) {
    return false;
  }
  return Boolean(text.trim() || allowSubmitWhenEmpty);
}

export function shouldSubmitLexicalModifiedEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  isComposing = false,
  metaKey = false,
  modifiedEnterSubmits,
  shiftKey = false,
  text,
}: LexicalModifiedEnterSubmitOptions): boolean {
  return (
    modifiedEnterSubmits &&
    (ctrlKey || metaKey) &&
    !shiftKey &&
    !isComposing &&
    Boolean(text.trim() || allowSubmitWhenEmpty)
  );
}

export function shouldResetLexicalEditorAfterSubmit(result: LexicalSubmitResult): boolean {
  return result !== false;
}

export function shouldNormalizeLeadingChineseSlashAliasInput({
  data,
  inputType,
  isAtEditorStart,
  isComposing = false,
}: LeadingChineseSlashAliasInputOptions): boolean {
  return (
    data === CHINESE_SLASH_ALIAS && inputType === "insertText" && isAtEditorStart && !isComposing
  );
}
