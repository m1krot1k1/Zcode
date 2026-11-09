import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

const { chatPromptEditorProps, editor, inputSetText } = vi.hoisted(() => {
  const editor = { text: "" };
  const inputSetText = vi.fn((value: string) => {
    editor.text = value;
  });
  const chatPromptEditorProps: Array<Record<string, unknown>> = [];
  return { chatPromptEditorProps, editor, inputSetText };
});

vi.mock("@/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      chatPromptEditorProps.push(props);
      const inputApiRef = props.inputApiRef as
        | { current: Record<string, unknown> | null }
        | undefined;
      if (inputApiRef) {
        inputApiRef.current = {
          clear: () => {
            editor.text = "";
          },
          focus: vi.fn(),
          getEditorState: () => null,
          getMarkdown: () => editor.text,
          setEditorStateJson: vi.fn(),
          setText: inputSetText,
        };
      }
      return React.createElement("form", { "data-testid": "mock-chat-prompt-editor" });
    },
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    React.createElement("div", props, children);
  const Trigger = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentHoverCard: Passthrough,
    AttachmentHoverCardContent: Passthrough,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Passthrough,
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    attachmentInputRef: { current: null },
    attachments: [],
    clearAttachments: vi.fn(),
    composerDragKind: null,
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    removeAttachment: vi.fn(),
    restoreDraftAttachments: vi.fn(),
    restoreSessionOwnedAttachments: vi.fn(() => true),
    retryAttachment: vi.fn(),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span", null, "mode"),
    V4ComposerModelControls: () => React.createElement("span", null, "model"),
  };
});

const attachmentPut = vi.fn() as unknown as AttachmentPutFn;
const onSelectModel = vi.fn();
const onSelectThought = vi.fn();
const onSendText = vi.fn(async () => {});
const onStop = vi.fn();
const onSwitchMode = vi.fn();
const replaceComposerDraft = vi.fn();
const updateComposerContent = vi.fn();

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    attributes: new Map<string, string>(),
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeAttribute: (name: string) => {
      element.attributes.delete(name);
    },
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      element.attributes.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } as Storage;
}

function installMinimalDom() {
  const target = new EventTarget();
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      parentNode: null,
    }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: target.addEventListener.bind(target),
    cancelAnimationFrame: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    localStorage: createStorageMock(),
    matchMedia: () => ({
      addEventListener: () => {},
      addListener: () => {},
      matches: false,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
    Node: function Node() {},
    removeEventListener: target.removeEventListener.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function renderComposer(options: {
  composerDraft: V4ComposerDraft;
  onTextChange: (text: string) => void;
  sessionId?: string | null;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const sessionId = options.sessionId ?? null;
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(ConversationComposer, {
      attachmentPut,
      composerDraft: options.composerDraft,
      draftMode: sessionId === null,
      listenAddToChatEvents: false,
      onSelectModel,
      onSelectThought,
      onSendText,
      onStop,
      onSwitchMode,
      onTextChange: options.onTextChange,
      replaceComposerDraft,
      sessionId,
      snapshot: null,
      updateComposerContent,
      workspaceIdentity: options.workspaceIdentity,
      workspacePath: options.workspacePath ?? "/workspace",
    }),
  );
}

function latestEditorOnChange(): (value: string) => void {
  const onChange = chatPromptEditorProps.at(-1)?.onChange;
  if (typeof onChange !== "function") {
    throw new Error("ChatPromptEditor did not receive onChange");
  }
  return onChange as (value: string) => void;
}

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  chatPromptEditorProps.length = 0;
  editor.text = "";
  inputSetText.mockClear();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationComposer draft restore", () => {
  it("keeps keystrokes typed ahead of composerDraft when onTextChange identity changes", () => {
    const container = installMinimalDom();
    root = createRoot(container);
    const composerDraft: V4ComposerDraft = { text: "ab", updatedAt: 1 };
    act(() => {
      root?.render(
        renderComposer({
          composerDraft,
          onTextChange: vi.fn(),
        }),
      );
    });
    expect(editor.text).toBe("ab");

    editor.text = "abc";
    act(() => {
      latestEditorOnChange()("abc");
    });
    expect(editor.text).toBe("abc");

    inputSetText.mockClear();
    act(() => {
      root?.render(
        renderComposer({
          composerDraft,
          onTextChange: vi.fn(),
        }),
      );
    });

    expect(editor.text).toBe("abc");
    expect(inputSetText).not.toHaveBeenCalledWith("ab");
  });

  it("still restores the draft when scope or workspace changes", () => {
    const container = installMinimalDom();
    root = createRoot(container);
    const onTextChange = vi.fn();
    act(() => {
      root?.render(
        renderComposer({
          composerDraft: { text: "ab", updatedAt: 1 },
          onTextChange,
        }),
      );
    });
    expect(editor.text).toBe("ab");

    act(() => {
      root?.render(
        renderComposer({
          composerDraft: { text: "zz", updatedAt: 2 },
          onTextChange,
          sessionId: "session-1",
        }),
      );
    });
    expect(editor.text).toBe("zz");

    act(() => {
      root?.render(
        renderComposer({
          composerDraft: { text: "id", updatedAt: 3 },
          onTextChange,
          sessionId: "session-1",
          workspaceIdentity: "remote-host-1",
          workspacePath: "/other-workspace",
        }),
      );
    });
    expect(editor.text).toBe("id");
  });
});
