import { describe, expect, it, vi } from "vitest";

import type { ProactiveSuggestionContext } from "@zcode/shared";

import { createProactiveSuggestionController } from "../src/v4/composer/proactive-suggestion/controller.js";

const EMPTY_CONTEXT: ProactiveSuggestionContext = {
  messages: [],
  assistantResult: null,
  toolResults: [],
  testResults: [],
  diffs: [],
  openFiles: [],
};

interface FakeResponse {
  suggestion: string | null;
  reason: null;
  requestId: string;
  latencyMs: number;
  modelUsed: null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(overrides: { enabled?: boolean; service?: boolean } = {}) {
  let id = 0;
  const requests: Array<{ requestId: string; sessionId: string; turnId: string }> = [];
  const pending = new Map<string, ReturnType<typeof deferred<FakeResponse>>>();
  const service = {
    complete: vi.fn((request) => {
      requests.push({
        requestId: request.requestId,
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      const d = deferred<FakeResponse>();
      pending.set(request.requestId, d);
      return d.promise;
    }),
    cancel: vi.fn(async () => {}),
  };
  const controller = createProactiveSuggestionController({
    service: overrides.service === false ? null : service,
    enabled: overrides.enabled ?? true,
    workspacePath: "/repo",
    contextProvider: () => EMPTY_CONTEXT,
    onStateChange: () => {},
    createRequestId: () => `request-${(id += 1)}`,
  });
  return { controller, service, requests, pending };
}

const completed = {
  sessionId: "s1",
  turnId: "t1",
  phase: "completedSuccess" as const,
  draft: "",
  disabled: false,
};

describe("proactive suggestion controller", () => {
  it("запрашивает только для completed + пустого draft + focus", () => {
    const { controller, requests } = setup();
    controller.sync({ ...completed, phase: "running" });
    controller.focus();
    expect(requests).toHaveLength(0);
    controller.sync({ ...completed, draft: "x" });
    controller.focus();
    expect(requests).toHaveLength(0);
    controller.sync(completed);
    controller.focus();
    expect(requests).toHaveLength(1);
  });

  it("не запрашивает при disabled, выключенной настройке и без сервиса", () => {
    const disabled = setup();
    disabled.controller.sync({ ...completed, disabled: true });
    disabled.controller.focus();
    expect(disabled.requests).toHaveLength(0);

    const off = setup({ enabled: false });
    off.controller.sync(completed);
    off.controller.focus();
    expect(off.requests).toHaveLength(0);

    const noService = setup({ service: false });
    noService.controller.sync(completed);
    noService.controller.focus();
    expect(noService.requests).toHaveLength(0);
  });

  it("accept возвращает текст и не отправляет", async () => {
    const { controller, pending } = setup();
    controller.sync(completed);
    controller.focus();
    [...pending.values()][0]!.resolve({
      suggestion: "Добавь тест",
      reason: null,
      requestId: "request-1",
      latencyMs: 1,
      modelUsed: null,
    });
    await flush();
    expect(controller.accept()).toBe("Добавь тест");
    expect(controller.getState().text).toBeNull();
  });

  it("blur скрывает, но кэширует; повторный focus показывает без запроса", async () => {
    const { controller, pending, service } = setup();
    controller.sync(completed);
    controller.focus();
    [...pending.values()][0]!.resolve({
      suggestion: "Добавь тест",
      reason: null,
      requestId: "request-1",
      latencyMs: 1,
      modelUsed: null,
    });
    await flush();
    controller.blur();
    expect(controller.getState().text).toBeNull();
    controller.focus();
    expect(controller.getState().text).toBe("Добавь тест");
    expect(pending.size).toBe(1);
    controller.dismiss();
    expect(service.cancel).not.toHaveBeenCalled();
    controller.focus();
    expect(controller.getState().text).toBeNull();
  });

  it("blur во время in-flight отменяет, не помечая turn decided", async () => {
    const { controller, pending, service, requests } = setup();
    controller.sync(completed);
    controller.focus();
    controller.blur();
    expect(service.cancel).toHaveBeenCalledTimes(1);
    const request = [...pending.values()][0]!;
    request.resolve({
      suggestion: "Поздний ответ",
      reason: null,
      requestId: "request-1",
      latencyMs: 1,
      modelUsed: null,
    });
    await flush();
    expect(controller.getState().text).toBeNull();
    controller.focus();
    expect(requests).toHaveLength(2);
  });

  it("дедуп: после accept тот же turn не показывает текст повторно", async () => {
    const { controller, pending, requests } = setup();
    controller.sync(completed);
    controller.focus();
    [...pending.values()][0]!.resolve({
      suggestion: "Добавь тест",
      reason: null,
      requestId: "request-1",
      latencyMs: 1,
      modelUsed: null,
    });
    await flush();
    controller.accept();
    controller.focus();
    expect(controller.getState().text).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("новый completed turn создаёт новый запрос", () => {
    const { controller, requests } = setup();
    controller.sync(completed);
    controller.focus();
    controller.sync({ ...completed, turnId: "t2" });
    controller.focus();
    expect(requests).toHaveLength(2);
  });

  it("stale ответ старого turn отбрасывается", async () => {
    const { controller, pending } = setup();
    controller.sync(completed);
    controller.focus();
    controller.sync({ ...completed, turnId: "t2" });
    [...pending.values()][0]!.resolve({
      suggestion: "Старый",
      reason: null,
      requestId: "request-1",
      latencyMs: 1,
      modelUsed: null,
    });
    await flush();
    expect(controller.getState().text).toBeNull();
  });
});
