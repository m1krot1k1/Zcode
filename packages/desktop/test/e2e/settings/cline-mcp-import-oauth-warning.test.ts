import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

const SESSION_MARKER = "E2E_CLINE_OAUTH_SESSION_MARKER";
const SERVER_NAME = "e2e-cline-oauth";
const WARNING_TEXT = [
  "Cline OAuth session data was not imported. Authorize this server again in ZCode.",
  "未导入 Cline OAuth 会话数据。请在 ZCode 中重新授权此服务器。",
];

describe("Cline MCP import shows reauthorization warning", () => {
  const paths = getE2EAppDataPaths();

  it("imports a disabled Cline SSE server without copying the OAuth session", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await writeClineMcpSettings(paths.homeDir);

    await openMcpSettings();
    await clickMoreActions();
    const importAction = await browser.$(
      '[data-settings-import-action="settings.mcp.import.open"]',
    );
    await importAction.waitForDisplayed({ timeout: 10_000 });
    await importAction.click();
    await waitForImportDiscovery();
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')?.click();
    });

    const importButton = await browser.$(
      'button[aria-label="Import to Global"], button[aria-label="导入到全局"]',
    );
    await importButton.waitForEnabled({ timeout: 10_000 });
    await importButton.click();

    await browser.waitUntil(async () => pageContainsAny(WARNING_TEXT), {
      timeout: 20_000,
      timeoutMsg: "导入结果没有显示 Cline 需要重新授权的警告",
    });
    expect(await pageText()).not.toContain(SESSION_MARKER);

    const saved = await readSavedServer(join(paths.storageRoot, "cli", "config.json"));
    expect(saved).toMatchObject({
      type: "sse",
      url: "https://mcp.example.test/e2e-cline-oauth",
      enabled: false,
      oauth: {
        type: "authorization_code",
        clientId: "e2e-cline-client",
      },
    });
    expect(JSON.stringify(saved)).not.toContain(SESSION_MARKER);
  });
});

async function writeClineMcpSettings(homeDir: string): Promise<void> {
  const settingsPath = join(homeDir, ".cline", "data", "settings", "cline_mcp_settings.json");
  await mkdir(join(homeDir, ".cline", "data", "settings"), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: {
            disabled: true,
            transport: {
              type: "sse",
              url: "https://mcp.example.test/e2e-cline-oauth",
            },
            oauthClient: { clientId: "e2e-cline-client" },
            oauth: {
              tokens: { access_token: SESSION_MARKER },
              codeVerifier: SESSION_MARKER,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function openMcpSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 15_000,
    timeoutMsg: "设置页没有渲染",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现 MCP 分区入口",
  });
}

async function waitForImportDiscovery(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await pageText();
    if (latest.includes("0/1")) {
      return;
    }
    await browser.pause(200);
  }
  throw new Error(`导入对话框没有发现可导入的 Cline MCP: ${latest.slice(0, 800)}`);
}

async function clickMoreActions(): Promise<void> {
  const trigger = await browser.$(
    'button[aria-label="More actions"], button[aria-label="更多操作"]',
  );
  await trigger.waitForDisplayed({ timeout: 15_000 });
  await trigger.click();
}

async function pageText(): Promise<string> {
  return browser.execute(() => document.body.innerText);
}

async function pageContainsAny(needles: readonly string[]): Promise<boolean> {
  const text = await pageText();
  return needles.some((needle) => text.includes(needle));
}

async function readSavedServer(configPath: string): Promise<Record<string, unknown>> {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await readFile(configPath, "utf8").catch(() => "");
      return latest.includes(SERVER_NAME);
    },
    {
      timeout: 15_000,
      timeoutMsg: `全局 MCP 配置没有保存 ${SERVER_NAME}`,
    },
  );
  const parsed = JSON.parse(latest) as {
    mcp?: { servers?: Record<string, Record<string, unknown>> };
  };
  const server = parsed.mcp?.servers?.[SERVER_NAME];
  if (!server) {
    throw new Error(`${SERVER_NAME} 不在 ${configPath}`);
  }
  return server;
}
