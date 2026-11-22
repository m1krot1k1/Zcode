/**
 * Lexical 编辑器的编程式内容操作。
 *
 * 所有写入都带 PROGRAMMATIC_UPDATE_TAG，供 slash/历史插件区分用户输入。
 * 从 LexicalChatInput.tsx 提取，导出名与行为保持不变。
 */
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";

/** 提取编辑器内容；mention 节点会在这里输出 markdown */
export function getEditorMarkdown(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getPromptMarkdown();
  });
  return text;
}

export function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      // Lexical getTextContent() 用 \n\n 分隔段落，对称处理防止换行翻倍
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        if (line) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      }

      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

const INLINE_PLUGIN_MENTION_PATTERN =
  /\[@((?:\\.|[^\]])+)\]\(plugin:\/\/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\)/g;

export function replaceEditorTextWithPluginMentions(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        let cursor = 0;
        for (const match of line.matchAll(INLINE_PLUGIN_MENTION_PATTERN)) {
          const start = match.index ?? 0;
          if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
          const markdown = match[0];
          const label = match[1]?.replaceAll("\\]", "]").replaceAll("\\[", "[") ?? "";
          const pluginId = match[2] ?? "";
          paragraph.append(
            $createPromptMentionNode({
              id: `plugin:${pluginId}`,
              category: "plugins",
              label,
              value: pluginId,
              markdown,
              data: { pluginId },
            }),
          );
          cursor = start + markdown.length;
        }
        if (cursor < line.length || paragraph.getChildrenSize() === 0) {
          paragraph.append($createTextNode(line.slice(cursor)));
        }
        root.append(paragraph);
      }
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function replaceEditorWithMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      // 预填后保留空格供用户直接继续输入；选区正确性由 TextNode 文本/DOM 契约保证。
      const trailing = $createTextNode(trailingText || " ");
      paragraph.append($createPromptMentionNode(mention), trailing);
      root.append(paragraph);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/**
 * 在草稿开头插入结构化 mention，同时保留已有 Lexical 节点和段落。
 *
 * 不能通过 getMarkdown → setMention 重建：setMention 是替换型预填，会把旧 mention
 * 序列化后作为普通 TextNode 放回编辑器，导致已有 Plugin / 文件 / Skill chip 降级。
 */
export function prependEditorMentionIfMissing(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
): boolean {
  let inserted = false;
  editor.update(
    () => {
      const root = $getRoot();
      const alreadyPresent = root
        .getAllTextNodes()
        .some(
          (node) =>
            $isPromptMentionNode(node) &&
            node.getMention().category === mention.category &&
            node.getMention().value === mention.value,
        );
      if (alreadyPresent) return;

      const mentionNode = $createPromptMentionNode(mention);
      const separator = $createTextNode(" ");
      const firstBlock = root.getFirstChild();
      if ($isParagraphNode(firstBlock)) {
        const firstInline = firstBlock.getFirstChild();
        if (firstInline) {
          firstInline.insertBefore(mentionNode);
          mentionNode.insertAfter(separator);
        } else {
          firstBlock.append(mentionNode, separator);
        }
      } else {
        const paragraph = $createParagraphNode().append(mentionNode, separator);
        if (firstBlock) firstBlock.insertBefore(paragraph);
        else root.append(paragraph);
      }
      separator.selectEnd();
      inserted = true;
    },
    // Prefill callers inspect/serialize the editor immediately after this helper returns.
    // A batched update would leave the new chip out of the current editor state.
    { tag: PROGRAMMATIC_UPDATE_TAG, discrete: true },
  );
  return inserted;
}

export function replaceEditorStateJson(editor: LexicalEditor, editorStateJson: string) {
  const editorState = editor.parseEditorState(editorStateJson);
  editor.setEditorState(editorState, { tag: PROGRAMMATIC_UPDATE_TAG });
}

export function resetEditor(editor: LexicalEditor) {
  replaceEditorText(editor, "");
}

export function replaceEditorWithSkillMention(
  editor: LexicalEditor,
  skillName: string,
  markdown = `$${skillName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-skill:${skillName}`,
          category: "skills",
          // 预填入口之前虽然会插入 skill node，但节点里保存的 markdown 仍固定成 `$slug`，
          // 导致像 New Skill 这种入口即使理论上有完整转译内容，进入输入框后也会被悄悄降级。
          // 这里显式透传原始 markdown，并直接显示 frontmatter name，避免 UI 再加工 skill 标题。
          label: skillName,
          value: skillName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function replaceEditorWithSlashCommandMention(
  editor: LexicalEditor,
  commandName: string,
  markdown = `/${commandName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-slash:${commandName}`,
          category: "commands",
          label: commandName,
          value: commandName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function appendEditorFileMention(
  editor: LexicalEditor,
  label: string,
  value: string,
  markdown: string,
  data?: MentionItemData,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append(
        $createPromptMentionNode({
          id: `dropped-file:${value}`,
          category: "files",
          label,
          value,
          markdown,
          data,
        }),
        $createTextNode(trailingText),
      );
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function appendEditorPlainText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/** 暴露 focus / clear / getText 给外部 */
export function insertEditorMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  selectionState?: EditorState,
) {
  const selection = selectionState?.read(() => $getSelection()?.clone() ?? null);
  editor.update(
    () => {
      // 浮层获取焦点后 Lexical 选区会丢失，恢复打开菜单前的光标，避免覆盖整份草稿。
      // 草稿可能在菜单打开期间被替换；旧节点不存在时不能恢复选区，否则 Lexical 会抛错。
      if ($isRangeSelection(selection)) {
        if ($getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          $getRoot().selectEnd();
        }
      }
      let target = $getSelection();
      if (!$isRangeSelection(target)) target = $getRoot().selectEnd();
      const trailing = $createTextNode(" ");
      target.insertNodes([$createPromptMentionNode(mention), trailing]);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// Голосовая диктовка вставляет текст в текущую позицию и затем заменяет только
// собственный диапазон. Диапазон хранится на редактор, чтобы кнопка микрофона,
// оверлей и Lexical-плагин не создавали второй owner текста.
interface VoiceDictationRange {
  startKey: string;
  startOffset: number;
  startType: "text" | "element";
  endKey: string;
  endOffset: number;
  endType: "text" | "element";
}

const voiceDictationRanges = new WeakMap<LexicalEditor, VoiceDictationRange>();

function captureVoiceEnd(range: VoiceDictationRange): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  range.endKey = selection.anchor.key;
  range.endOffset = selection.anchor.offset;
  range.endType = selection.anchor.type;
}

export function beginEditorVoiceDictation(editor: LexicalEditor) {
  editor.update(
    () => {
      let selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        $getRoot().selectEnd();
        selection = $getSelection();
      }
      if (!$isRangeSelection(selection)) return;
      const range: VoiceDictationRange = {
        startKey: selection.anchor.key,
        startOffset: selection.anchor.offset,
        startType: selection.anchor.type,
        endKey: selection.anchor.key,
        endOffset: selection.anchor.offset,
        endType: selection.anchor.type,
      };
      voiceDictationRanges.set(editor, range);
    },
    { tag: PROGRAMMATIC_UPDATE_TAG, discrete: true },
  );
}

export function applyEditorVoiceDictation(editor: LexicalEditor, text: string, final = false) {
  editor.update(
    () => {
      const range = voiceDictationRanges.get(editor);
      if (!range) return;
      const startNode = $getNodeByKey(range.startKey);
      const endNode = $getNodeByKey(range.endKey);
      const selection = $createRangeSelection();
      if (startNode && endNode) {
        selection.anchor.set(range.startKey, range.startOffset, range.startType);
        selection.focus.set(range.endKey, range.endOffset, range.endType);
      } else {
        // Пользователь мог изменить draft во время записи: не дублируем текст,
        // а продолжаем с конца. Диапазон пересчитывается после вставки.
        $getRoot().selectEnd();
        const endSelection = $getSelection();
        if (!$isRangeSelection(endSelection)) return;
        selection.anchor.set(
          endSelection.anchor.key,
          endSelection.anchor.offset,
          endSelection.anchor.type,
        );
        selection.focus.set(
          endSelection.anchor.key,
          endSelection.anchor.offset,
          endSelection.anchor.type,
        );
        range.startKey = endSelection.anchor.key;
        range.startOffset = endSelection.anchor.offset;
        range.startType = endSelection.anchor.type;
      }
      $setSelection(selection);
      selection.insertText(text);
      captureVoiceEnd(range);
      if (range.startType === "element") {
        // An empty Composer starts with an element selection. After the first
        // insert, remember the inserted text range so the next partial replaces
        // it instead of appending a second copy.
        const after = $getSelection();
        if ($isRangeSelection(after) && after.anchor.type === "text") {
          range.startKey = after.anchor.key;
          range.startOffset = Math.max(0, after.anchor.offset - text.length);
          range.startType = "text";
        }
      }
      if (final) voiceDictationRanges.delete(editor);
    },
    { tag: PROGRAMMATIC_UPDATE_TAG, discrete: true },
  );
}

export function cancelEditorVoiceDictation(editor: LexicalEditor) {
  applyEditorVoiceDictation(editor, "", true);
}
