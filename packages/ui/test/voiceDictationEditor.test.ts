import { createEditor, $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import {
  applyEditorVoiceDictation,
  beginEditorVoiceDictation,
  cancelEditorVoiceDictation,
} from "../src/lexical-chat-input/editorOperations.js";

function createTextEditor(initialText: string) {
  const editor = createEditor({
    namespace: "voice-dictation-test",
    onError: (error) => {
      throw error;
    },
    theme: {},
  });
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(initialText));
      $getRoot().append(paragraph);
      paragraph.selectEnd();
    },
    { discrete: true },
  );
  return editor;
}

function readText(editor: ReturnType<typeof createTextEditor>): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

describe("voice dictation editor operations", () => {
  it("inserts at the caret and replaces only the dictated range", () => {
    const editor = createTextEditor("Before ");
    beginEditorVoiceDictation(editor);
    applyEditorVoiceDictation(editor, "hello");
    expect(readText(editor)).toBe("Before hello");

    applyEditorVoiceDictation(editor, "hello world");
    expect(readText(editor)).toBe("Before hello world");

    applyEditorVoiceDictation(editor, "hello world!", true);
    expect(readText(editor)).toBe("Before hello world!");
  });

  it("replaces subsequent partials when dictation starts in an empty paragraph", () => {
    const editor = createEditor({
      namespace: "voice-dictation-empty-test",
      onError: (error) => {
        throw error;
      },
      theme: {},
    });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectStart();
      },
      { discrete: true },
    );
    beginEditorVoiceDictation(editor);
    applyEditorVoiceDictation(editor, "Привет");
    applyEditorVoiceDictation(editor, "Привет, это проверка");
    applyEditorVoiceDictation(editor, "Привет, это проверка.", true);
    expect(readText(editor)).toBe("Привет, это проверка.");
  });

  it("keeps surrounding draft text and cancels only the inserted range", () => {
    const editor = createTextEditor("Keep this");
    // Start in the middle of the existing text.
    editor.update(
      () => {
        const text = $getRoot().getFirstChild()?.getFirstChild();
        if (text) text.select(3, 3);
      },
      { discrete: true },
    );
    beginEditorVoiceDictation(editor);
    applyEditorVoiceDictation(editor, "NEW");
    expect(readText(editor)).toBe("KeeNEWp this");

    cancelEditorVoiceDictation(editor);
    expect(readText(editor)).toBe("Keep this");
  });
});
