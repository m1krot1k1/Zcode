import {
  $applyNodeReplacement,
  $createTextNode,
  $isTextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from "lexical";

/**
 * `GhostTextNode` — нативная inline-нода предсказания.
 *
 * Отличия от обычного `TextNode`, которые здесь принципиальны:
 * - `isUnmergeable`/`canInsertTextBefore=false` не дают вводу «склеиться» с подсказкой;
 * - `excludeFromCopy()` — ghost-текст не попадает в буфер обмена;
 * - сериализация (`getMarkdown`/`getTextContent`) не участвует в отправке сообщения:
 *   содержимое живёт в `__ghostText` и читается только плагином;
 * - DOM-узел декоративный: `aria-hidden`, `pointer-events-none`, `select-none`.
 *
 * Ghost-текст никогда не попадает в документ как обычный текст: плагин заменяет узел
 * на `TextNode` только после явного принятия (`Tab`/`ArrowRight`/клик).
 */

export interface GhostTextNodePayload {
  text: string;
  /** Кто предложил подсказку: кэш префиксов или модель. Используется в тестах. */
  source?: string;
}

type SerializedGhostTextNode = SerializedTextNode & {
  type: "ghost-text";
  version: 1;
  ghostText: string;
  source?: string;
};

export class GhostTextNode extends TextNode {
  __ghostText: string;
  __source: string;

  static getType(): string {
    return "ghost-text";
  }

  static clone(node: GhostTextNode): GhostTextNode {
    return new GhostTextNode(
      { text: node.__ghostText, source: node.__source },
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedGhostTextNode): GhostTextNode {
    const node = $createGhostTextNode({
      text: serializedNode.ghostText,
      source: serializedNode.source,
    });
    node.setFormat(serializedNode.format);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  constructor(payload: GhostTextNodePayload, key?: NodeKey) {
    // Текст ноды остаётся пустым: ghost-текст не участвует в обычной сериализации.
    super("", key);
    this.__ghostText = payload.text;
    this.__source = payload.source ?? "model";
  }

  getGhostText(): string {
    return this.getLatest().__ghostText;
  }

  setGhostText(text: string): void {
    const writable = this.getWritable();
    writable.__ghostText = text;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    applyGhostDom(dom, this.__ghostText, this.__source);
    return dom;
  }

  updateDOM(prevNode: GhostTextNode, dom: HTMLElement, config: EditorConfig): boolean {
    const shouldReplace = super.updateDOM(prevNode as this, dom, config);
    if (shouldReplace) return true;
    if (prevNode.__ghostText !== this.__ghostText || prevNode.__source !== this.__source) {
      applyGhostDom(dom, this.__ghostText, this.__source);
      return true;
    }
    return false;
  }

  exportJSON(): SerializedGhostTextNode {
    return {
      ...super.exportJSON(),
      type: "ghost-text",
      version: 1,
      ghostText: this.__ghostText,
      ...(this.__source ? { source: this.__source } : {}),
    };
  }

  /** Пустая строка: ghost-текст не должен попадать в markdown отправляемого сообщения. */
  getMarkdown(): string {
    return "";
  }

  /** Ghost-текст не участвует в текстовом содержимом документа. */
  getTextContent(): string {
    return "";
  }

  isTextEntity(): true {
    return true;
  }

  isUnmergeable(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  /** Ghost-текст не копируется: буфер обмена содержит только введённое пользователем. */
  excludeFromCopy(): true {
    return true;
  }
}

function applyGhostDom(dom: HTMLElement, text: string, source: string): void {
  dom.setAttribute("data-testid", "chat-ghost-text");
  dom.setAttribute("data-ghost-source", source);
  dom.setAttribute("aria-hidden", "true");
  dom.setAttribute("spellcheck", "false");
  // Классы строго из design-tokens: цвет подсказки — самый слабый foreground.
  dom.className =
    "pointer-events-none select-none whitespace-pre-wrap text-foreground-subtlest opacity-70";
  dom.textContent = text;
}

export function $createGhostTextNode(payload: GhostTextNodePayload): GhostTextNode {
  const node = new GhostTextNode(payload);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isGhostTextNode(node: LexicalNode | null | undefined): node is GhostTextNode {
  return node instanceof GhostTextNode;
}

/**
 * Заменяет ghost-ноду обычным текстом: единственная точка «принятия» подсказки.
 * Возвращает созданный `TextNode` (или `null`, если ghost-ноды нет).
 */
export function $acceptGhostText(node: GhostTextNode): TextNode | null {
  const text = node.getGhostText();
  if (!text) {
    node.remove();
    return null;
  }
  const accepted = $createTextNode(text);
  node.replace(accepted);
  return accepted;
}

/** Удаляет ghost-ноду, не затрагивая введённый пользователем текст. */
export function $removeGhostText(node: GhostTextNode | null): void {
  if (!node) return;
  if (!$isTextNode(node)) return;
  node.remove();
}
