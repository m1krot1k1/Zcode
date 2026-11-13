import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, setCurrentElectronRendererContentSize } from "../desktop-app.js";

/** 读取后台工作面板项（workId + status）。 */
export function getV4BackgroundWorks(): Promise<Array<{ workId: string; status: string | null }>> {
  return browser.execute((itemPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`),
    ).map((el) => ({
      workId: el.getAttribute("data-work-id") ?? "",
      status: el.getAttribute("data-work-status"),
    }));
  }, TID_V4_BACKGROUND_WORK_ITEM);
}

/** 读取 Composer 当前 session 的后台任务计数与响应式展示形态；无入口返回 null。 */
export function getV4ComposerBackgroundWorkCounts(): Promise<{
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
  /** 入口点击的落点（docs/dynamic-workflow/presentation.md）："panel" | "workflow-run"。 */
  openTarget: string;
  typedVisible: boolean;
  compactVisible: boolean;
} | null> {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
    if (!trigger) return null;
    const isVisible = (layout: string) => {
      const element = trigger.querySelector<HTMLElement>(
        `[data-composer-background-layout="${layout}"]`,
      );
      return Boolean(element && getComputedStyle(element).display !== "none");
    };
    return {
      bashCount: Number(trigger.dataset.backgroundBashCount ?? "0"),
      workflowCount: Number(trigger.dataset.backgroundWorkflowCount ?? "0"),
      subagentCount: Number(trigger.dataset.backgroundSubagentCount ?? "0"),
      totalCount: Number(trigger.dataset.backgroundTotalCount ?? "0"),
      openTarget: trigger.dataset.backgroundOpenTarget ?? "panel",
      typedVisible: isVisible("typed"),
      compactVisible: isVisible("compact"),
    };
  }, TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
}

/** Electron driver 不实现 WebDriver window/rect；通过主进程 BrowserWindow 调整 viewport。 */
export async function setV4ElectronWindowSize(width: number, height: number) {
  // Bug 根因：外框和 renderer 内容区的差值随平台及 zoom 改变，固定误差会误报超时。
  // 复用精确绑定当前窗口的内容区 helper，同时保留尺寸应用失败的断言。
  await setCurrentElectronRendererContentSize(width, height);
}

/** 从 Composer 单一入口展开 Status panel，并直达所有非空后台类型区块。 */
export async function openV4ComposerRunningBackgroundWorks(timeout = 30000) {
  await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, {
    timeout,
    timeoutMsg: "Composer 后台任务入口没有出现或不可点击",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, itemPrefix) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const terminalCount = Number(panel?.dataset.runningTerminalCount ?? "0");
          const agentCount = Number(panel?.dataset.runningAgentCount ?? "0");
          const terminalTrigger = panel?.querySelector<HTMLElement>(
            '[data-status-section-trigger="terminal"]',
          );
          const agentTrigger = panel?.querySelector<HTMLElement>(
            '[data-status-section-trigger="agent"]',
          );
          return Boolean(
            panel?.dataset.state === "expanded" &&
            (terminalCount === 0 || terminalTrigger?.getAttribute("aria-expanded") === "true") &&
            (agentCount === 0 || agentTrigger?.getAttribute("aria-expanded") === "true") &&
            panel.querySelector(`[data-testid^="${itemPrefix}-"]`),
          );
        },
        TID_CHAT_SUMMARY_PANEL,
        TID_V4_BACKGROUND_WORK_ITEM,
      ),
    { timeout, timeoutMsg: "Composer 入口没有直达展开的终端/智能体明细" },
  );
}

/** 展开统一 status panel 的非空后台类型区块；定位只依赖结构化属性，不依赖中英文。 */
export async function openV4RunningBackgroundWorks(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, itemPrefix) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          if (!panel || Number(panel.dataset.runningBackgroundCount ?? "0") < 1) {
            return false;
          }
          if (panel.dataset.state === "collapsed") {
            panel.querySelector<HTMLButtonElement>("button")?.click();
            return false;
          }
          const sections = [
            {
              count: Number(panel.dataset.runningTerminalCount ?? "0"),
              name: "terminal",
            },
            {
              count: Number(panel.dataset.runningAgentCount ?? "0"),
              name: "agent",
            },
          ];
          let allOpen = true;
          for (const section of sections) {
            if (section.count === 0) continue;
            const trigger = panel.querySelector<HTMLButtonElement>(
              `[data-status-section-trigger="${section.name}"]`,
            );
            if (!trigger) return false;
            if (trigger.getAttribute("aria-expanded") !== "true") {
              trigger.click();
              allOpen = false;
            }
          }
          return allOpen && Boolean(panel.querySelector(`[data-testid^="${itemPrefix}-"]`));
        },
        TID_CHAT_SUMMARY_PANEL,
        TID_V4_BACKGROUND_WORK_ITEM,
      ),
    { timeout, timeoutMsg: "status panel 没有展开终端/智能体 background work" },
  );
}

export function getLatestV4CommandAck(type: string): Promise<{
  type: string;
  status: string;
  reasonCode?: string;
} | null> {
  return browser.execute((commandType) => {
    const entries =
      (
        window as Window & {
          __zcodeV4CommandAcksE2E?: Array<{
            type: string;
            status: string;
            reasonCode?: string;
          }>;
        }
      ).__zcodeV4CommandAcksE2E ?? [];
    return [...entries].reverse().find((entry) => entry.type === commandType) ?? null;
  }, type);
}

/** 等待指定 v4 command 的结构化 ACK，避免业务断言把 command 卡住误报成模型无回复。 */
export async function waitForLatestV4CommandAck(type: string, timeout = 30000) {
  let latest: Awaited<ReturnType<typeof getLatestV4CommandAck>> = null;
  await browser.waitUntil(
    async () => {
      latest = await getLatestV4CommandAck(type);
      return latest !== null;
    },
    { timeout, timeoutMsg: `v4 command 没有返回 ACK: ${type}` },
  );
  return latest!;
}

/** 点击某后台工作的取消按钮（cancelBackgroundWork 命令，按 workId）。 */
export async function clickV4BackgroundWorkCancel(workId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-background-work-cancel-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, workId);
}
