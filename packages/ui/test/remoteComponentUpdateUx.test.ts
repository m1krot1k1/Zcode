// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceServerConnectionStateSnapshot, SourceServerOperationLog } from "@zcode/shared";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import englishMessages from "@/i18n/locales/en-US.js";
import russianMessages from "@/i18n/locales/ru-RU.json" with { type: "json" };
import chineseMessages from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

vi.mock("@/settings/source-server-management-panel/panelContext.js", () => ({
  usePanelRuntime: () => ({
    run: vi.fn(async () => {}),
    platform: null,
    updateProfile: vi.fn(async () => {}),
    busyOperations: new Set<string>(),
  }),
}));

import { DeviceUpdateBanner } from "@/settings/source-server-management-panel/DeviceUpdateBanner.js";
import { RemoteConnectionForceUpdatePanel } from "@/remote-connection/connecting-step/RemoteConnectionForceUpdatePanel.js";
import { SourceServerUpdateActivity } from "@/settings/SourceServerUpdateActivity.js";

type Locale = "en-US" | "ru-RU" | "zh-CN";

const messages: Record<Locale, Record<string, string>> = {
  "en-US": englishMessages,
  "ru-RU": russianMessages,
  "zh-CN": chineseMessages,
};

const locales = Object.keys(messages) as Locale[];

const expectedCopy = {
  "remote.phaseSub.restarting": {
    "en-US": "Restarting the ZCode service",
    "ru-RU": "Перезапуск службы ZCode",
    "zh-CN": "正在重启 ZCode 服务",
  },
  "settings.source.updateInProgress": {
    "en-US": "Updating the ZCode remote component…",
    "ru-RU": "Обновление удалённого компонента ZCode…",
    "zh-CN": "正在更新 ZCode 远程组件…",
  },
  "remote.connectingSubtitleUpdating": {
    "en-US": "Updating the ZCode remote component…",
    "ru-RU": "Обновление удалённого компонента ZCode…",
    "zh-CN": "正在更新 ZCode 远程组件…",
  },
  "settings.source.updateScopeNote": {
    "en-US":
      "Only the ZCode remote component is updated and restarted. Your OS and device are not rebooted.",
    "ru-RU":
      "Обновляется и перезапускается только удалённый компонент ZCode. Операционная система и устройство не перезагружаются.",
    "zh-CN": "只更新并重启 ZCode 远程组件，操作系统和设备不会重启。",
  },
  "settings.source.forceUpdateDescription": {
    "en-US":
      "A forced update interrupts tasks that are still running on this device and restarts only the ZCode service. The session reconnects automatically. Confirm that these tasks may be interrupted.",
    "ru-RU":
      "Принудительное обновление прервёт выполняющиеся задачи на этом устройстве и перезапустит только службу ZCode. Сессия переподключится автоматически. Подтвердите, что эти задачи можно прервать.",
    "zh-CN":
      "强制更新会中断此设备上仍在运行的任务，并且只重启 ZCode 服务。会话会自动重新连接。请确认这些任务可以停止。",
  },
  "remote.runningTasksUnavailable": {
    "en-US":
      "The device did not report its task list. A forced update interrupts running tasks and restarts only the ZCode service. The session reconnects automatically.",
    "ru-RU":
      "Устройство не предоставило список задач. Принудительное обновление прервёт выполняющиеся задачи и перезапустит только службу ZCode. Сессия переподключится автоматически.",
    "zh-CN":
      "设备未提供任务清单。强制更新会中断正在运行的任务，并且只重启 ZCode 服务。会话会自动重新连接。",
  },
} satisfies Record<string, Record<Locale, string>>;

const scopeFacts: Record<Locale, readonly string[]> = {
  "en-US": ["Only the ZCode remote component", "OS", "device", "not rebooted"],
  "ru-RU": [
    "только удалённый компонент ZCode",
    "Операционная система",
    "устройство",
    "не перезагружаются",
  ],
  "zh-CN": ["只更新并重启 ZCode 远程组件", "操作系统", "设备", "不会重启"],
};

const forceFacts: Record<Locale, readonly string[]> = {
  "en-US": ["interrupts", "only the ZCode service", "reconnects automatically"],
  "ru-RU": ["прервёт выполняющиеся задачи", "только службу ZCode", "переподключится автоматически"],
  "zh-CN": ["中断", "只重启 ZCode 服务", "自动重新连接"],
};

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";

const updatingState = {
  profileId,
  state: "updating",
  updatedAt: 1,
} as SourceServerConnectionStateSnapshot;

const updatePresentation = {
  primaryAction: "update-server",
  updateNotice: { foreground: "", surface: "" },
} as unknown as RemoteConnectionPresentation;

afterEach(cleanup);

describe("remote component update copy", () => {
  it.each(
    Object.entries(expectedCopy).flatMap(([key, copyByLocale]) =>
      (Object.entries(copyByLocale) as [Locale, string][]).map(
        ([locale, copy]) => [key, locale, copy] as const,
      ),
    ),
  )("%s keeps the exact %s wording", (key, locale, copy) => {
    expect(messages[locale][key]).toBe(copy);
  });

  it.each(locales)("%s never restarts the remote server or device", (locale) => {
    for (const key of [
      "remote.phaseSub.restarting",
      "settings.source.updateInProgress",
      "remote.connectingSubtitleUpdating",
    ] as const) {
      const copy = messages[locale][key];
      expect(copy).toContain("ZCode");
      expect(copy.toLowerCase()).not.toContain("remote server");
      expect(copy.toLowerCase()).not.toContain("удалённый сервер");
      expect(copy).not.toContain("远端服务");
    }
  });

  it.each(locales)("%s scope note limits the restart to the ZCode component", (locale) => {
    const copy = messages[locale]["settings.source.updateScopeNote"];
    for (const fact of scopeFacts[locale]) expect(copy).toContain(fact);
  });

  it.each(locales)("%s force warning lists interruption and automatic reconnect", (locale) => {
    for (const key of [
      "settings.source.forceUpdateDescription",
      "remote.runningTasksUnavailable",
    ] as const) {
      const copy = messages[locale][key];
      for (const fact of forceFacts[locale]) expect(copy).toContain(fact);
    }
  });
});

describe("remote component update surfaces", () => {
  it("maps the restart phase to the ZCode service restart copy", () => {
    const logs: SourceServerOperationLog[] = [
      {
        profileId,
        operation: "update",
        phase: "restart",
        level: "info",
        message: "[source-server:restart] restarting",
        timestamp: 1,
      },
    ];
    render(createElement(SourceServerUpdateActivity, { active: true, logs }));
    expect(screen.getByText("remote.phaseSub.restarting")).toBeTruthy();
    expect(screen.queryByText("remote.phaseSub.verifyingFiles")).toBeNull();
  });

  it("renders the exact localized restart copy through the real IntlProvider", async () => {
    // Остальные кейсы файла проверяют id сообщений через formatter-мок.
    // Для проверки реального перевода поднимаем модули заново без мока провайдера.
    vi.resetModules();
    vi.doUnmock("@/i18n/IntlProvider.js");
    const [{ ZCodeIntlProvider }, { SourceServerUpdateActivity: RealUpdateActivity }] =
      await Promise.all([
        import("@/i18n/IntlProvider.js"),
        import("@/settings/SourceServerUpdateActivity.js"),
      ]);

    const logs: SourceServerOperationLog[] = [
      {
        profileId,
        operation: "update",
        phase: "restart",
        level: "info",
        message: "[source-server:restart] restarting",
        timestamp: 1,
      },
    ];
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "ru-RU" },
        createElement(RealUpdateActivity, { active: true, logs }),
      ),
    );
    expect(screen.getByText("Перезапуск службы ZCode")).toBeTruthy();
    expect(screen.queryByText("remote.phaseSub.restarting")).toBeNull();
  });

  it("shows the scope note while the remote component is updating", () => {
    render(
      createElement(DeviceUpdateBanner, {
        serverState: updatingState,
        presentation: updatePresentation,
        updateFailed: false,
        updateFailureText: null,
        updateKey: "profile-key",
        serverProfiles: [],
        operationLogs: [],
        deviceBusy: false,
      }),
    );
    expect(screen.getByText("settings.source.updateInProgress")).toBeTruthy();
    expect(screen.getByText("settings.source.updateScopeNote")).toBeTruthy();
  });

  it("does not show the scope note outside an active update", () => {
    render(
      createElement(DeviceUpdateBanner, {
        serverState: { ...updatingState, state: "online" },
        presentation: { ...updatePresentation, primaryAction: "connect" },
        updateFailed: false,
        updateFailureText: null,
        updateKey: "profile-key",
        serverProfiles: [],
        operationLogs: [],
        deviceBusy: false,
      }),
    );
    expect(screen.queryByText("settings.source.updateScopeNote")).toBeNull();
  });

  it("lists running tasks next to the interruption warning before a forced update", () => {
    render(
      createElement(RemoteConnectionForceUpdatePanel, {
        forceUpdate: {
          tasks: [{ sessionId: "running-session", workspacePath: "/work/alpha" }],
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        },
      }),
    );
    expect(screen.getByText("settings.source.forceUpdateDescription")).toBeTruthy();
    expect(screen.getByText("running-session")).toBeTruthy();
    expect(screen.getByText("/work/alpha")).toBeTruthy();
    expect(screen.queryByText("remote.runningTasksUnavailable")).toBeNull();
  });

  it("keeps the same warning when the device cannot report running tasks", () => {
    render(
      createElement(RemoteConnectionForceUpdatePanel, {
        forceUpdate: {
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        },
      }),
    );
    expect(screen.getByText("settings.source.forceUpdateDescription")).toBeTruthy();
    expect(screen.getByText("remote.runningTasksUnavailable")).toBeTruthy();
  });
});
