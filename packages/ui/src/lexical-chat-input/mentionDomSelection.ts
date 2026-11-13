/**
 * mention token 的 DOM 边界判定与选区修复。
 *
 * 供 KeyboardPlugin 处理 macOS Option+ArrowRight 落入 mention token 内部的问题。
 */
import { $getRoot, $isTextNode } from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

export function getPromptMentionIdAfterDomSelection(rootElement: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!rootElement.contains(anchorNode)) {
    return null;
  }

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const child = anchorNode.childNodes.item(selection.anchorOffset);
    return getPromptMentionIdFromBoundaryNode(child);
  }

  if (anchorNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  if (selection.anchorOffset !== (anchorNode.textContent ?? "").length) {
    return null;
  }

  return getPromptMentionIdFromBoundaryNode(anchorNode.nextSibling);
}

function getPromptMentionIdFromBoundaryNode(node: Node | null): string | null {
  if (!(node instanceof HTMLElement) || !node.matches("[data-mention-id]")) {
    return null;
  }
  return node.dataset.mentionId ?? null;
}

export function selectAfterPromptMentionById(mentionId: string): boolean {
  const mentionNode = $getRoot()
    .getAllTextNodes()
    .find((node) => $isPromptMentionNode(node) && node.getMention().id === mentionId);
  if (!mentionNode) {
    return false;
  }

  const nextSibling = mentionNode.getNextSibling();
  if ($isTextNode(nextSibling)) {
    const text = nextSibling.getTextContent();
    const offset = /^\s/.test(text) ? Math.min(1, text.length) : 0;
    nextSibling.select(offset, offset);
    return true;
  }

  mentionNode.selectNext(0, 0);
  return true;
}
