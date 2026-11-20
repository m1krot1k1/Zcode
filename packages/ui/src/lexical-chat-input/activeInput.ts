import type { LexicalChatInputHandle } from "./types.js";

/**
 * The focused Composer's imperative editor API.
 *
 * Voice dictation lives in another UI module; it must not create a second draft
 * or reach into Lexical directly. The Lexical module publishes the active
 * handle here, and the voice controller edits through the same handle as typing.
 */
let activeInput: LexicalChatInputHandle | null = null;

export function setActiveLexicalChatInput(handle: LexicalChatInputHandle | null): void {
  activeInput = handle;
}

export function getActiveLexicalChatInput(): LexicalChatInputHandle | null {
  return activeInput;
}
