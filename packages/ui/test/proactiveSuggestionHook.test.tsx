// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProactiveSuggestionContext,
  ProactiveSuggestionRequest,
  ProactiveSuggestionResponse,
} from "@zcode/shared";

import { useComposerProactiveSuggestion } from "../src/v4/composer/proactive-suggestion/useComposerProactiveSuggestion.js";

function Harness(props: {
  complete: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onAccept: (text: string) => void;
  focusEditor: () => void;
  contextProvider?: (() => ProactiveSuggestionContext) | undefined;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // jsdom не реализует contentEditable/isContentEditable: реальный атрибут нужен
  // для focusout-детекции редактора (`closest('[contenteditable="true"]')`).
  useEffect(() => {
    editorRef.current?.setAttribute("contenteditable", "true");
  }, []);
  const state = useComposerProactiveSuggestion({
    service: {
      complete: props.complete as (
        request: ProactiveSuggestionRequest,
      ) => Promise<ProactiveSuggestionResponse>,
      cancel: props.cancel as (params: { requestId: string }) => Promise<void>,
    },
    settings: { enabled: true, maxSuggestionsPerTurn: 1 },
    sessionId: "session-1",
    turnId: "turn-1",
    phase: "completedSuccess",
    draft: "",
    disabled: false,
    workspacePath: "/repo",
    context: {
      messages: [{ role: "user", text: "Добавь тест" }],
      assistantResult: "Готово",
      toolResults: [],
      testResults: [],
      diffs: [],
      openFiles: [],
    },
    ...(props.contextProvider ? { contextProvider: props.contextProvider } : {}),
    labels: { loading: "loading", hint: "Tab", dismiss: "dismiss" },
    containerRef,
    onAccept: props.onAccept,
    focusEditor: props.focusEditor,
  });
  return (
    <div ref={containerRef} data-testid="composer-container">
      <div data-testid="editor" ref={editorRef} />
      <button type="button" data-testid="toolbar">
        toolbar
      </button>
      {state.node}
    </div>
  );
}

function renderHarness(overrides: { contextProvider?: () => ProactiveSuggestionContext } = {}) {
  let resolveComplete: (value: ProactiveSuggestionResponse) => void = () => {};
  const complete = vi.fn(
    () =>
      new Promise<ProactiveSuggestionResponse>((resolve) => {
        resolveComplete = resolve;
      }),
  );
  const cancel = vi.fn(async () => {});
  const onAccept = vi.fn();
  const focusEditor = vi.fn();
  render(
    <Harness
      complete={complete}
      cancel={cancel}
      onAccept={onAccept}
      focusEditor={focusEditor}
      contextProvider={overrides.contextProvider}
    />,
  );
  return {
    complete,
    cancel,
    onAccept,
    focusEditor,
    resolve: (suggestion: string | null) => {
      resolveComplete({
        requestId: "proactive-1",
        suggestion,
        reason: null,
        latencyMs: 1,
        modelUsed: null,
      });
    },
  };
}

describe("useComposerProactiveSuggestion", () => {
  afterEach(() => {
    cleanup();
  });

  it("focus запрашивает один раз; blur в другой редактор не скрывает; blur наружу кэширует; Tab принимает с фокусом", async () => {
    const harness = renderHarness();
    const editor = screen.getByTestId("editor");

    fireEvent.focusIn(editor);
    expect(harness.complete).toHaveBeenCalledTimes(1);

    const otherEditor = document.createElement("div");
    otherEditor.setAttribute("contenteditable", "true");
    document.body.appendChild(otherEditor);
    fireEvent.focusOut(editor, { relatedTarget: otherEditor });
    expect(harness.complete).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.resolve("Добавь тест на отмену");
    });
    expect(screen.getByText("Добавь тест на отмену")).toBeTruthy();

    fireEvent.focusOut(editor, { relatedTarget: document.body });
    expect(screen.queryByText("Добавь тест на отмену")).toBeNull();

    fireEvent.focusIn(editor);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Добавь тест на отмену")).toBeTruthy();

    fireEvent.keyDown(editor, { key: "Tab" });
    expect(harness.onAccept).toHaveBeenCalledWith("Добавь тест на отмену");
    expect(harness.focusEditor).toHaveBeenCalledTimes(1);
  });

  it("клик по подсказке принимает и возвращает фокус в редактор", async () => {
    const harness = renderHarness();
    const editor = screen.getByTestId("editor");
    fireEvent.focusIn(editor);
    await act(async () => {
      harness.resolve("Запусти тесты");
    });
    fireEvent.click(screen.getByText("Запусти тесты"));
    expect(harness.onAccept).toHaveBeenCalledWith("Запусти тесты");
    expect(harness.focusEditor).toHaveBeenCalledTimes(1);
  });

  it("Escape во время loading отменяет запрос и закрывает подсказку без нового запроса", () => {
    const harness = renderHarness();
    const editor = screen.getByTestId("editor");
    fireEvent.focusIn(editor);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(screen.getByText("loading")).toBeTruthy();

    fireEvent.keyDown(editor, { key: "Escape" });
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("loading")).toBeNull();

    fireEvent.focusIn(editor);
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("третий focus не создаёт третий запрос (cap 2 attempts на turn)", () => {
    const harness = renderHarness();
    const editor = screen.getByTestId("editor");
    fireEvent.focusIn(editor);
    fireEvent.focusOut(editor, { relatedTarget: document.body });
    fireEvent.focusIn(editor);
    fireEvent.focusOut(editor, { relatedTarget: document.body });
    fireEvent.focusIn(editor);
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("loading")).toBeNull();
  });

  it("mount-подобный contextProvider собирает контекст в момент запроса", () => {
    const provider = vi.fn(
      (): ProactiveSuggestionContext => ({
        messages: [{ role: "user", text: "свежий контекст" }],
        assistantResult: null,
        toolResults: [],
        testResults: [],
        diffs: [],
        openFiles: [],
      }),
    );
    const harness = renderHarness({ contextProvider: provider });
    expect(provider).not.toHaveBeenCalled();
    fireEvent.focusIn(screen.getByTestId("editor"));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.complete.mock.calls[0]?.[0]?.context).toEqual({
      messages: [{ role: "user", text: "свежий контекст" }],
      assistantResult: null,
      toolResults: [],
      testResults: [],
      diffs: [],
      openFiles: [],
    });
  });
});
