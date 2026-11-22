import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  applyCodingPlanUpgradeMockEnv,
  clearCodingPlanUpgradeMockEnv,
} from "../helpers/coding-plan-mock-env.js";
import {
  resolveHighspeedE2EMockScenario,
  HIGHSPEED_MOCK_SCENARIO_ENV,
} from "../helpers/highspeed-mock-env.js";
import {
  resolveCodingPlanUpgradeMockScenario,
  shouldPrepareCodingPlanUpgradeMockForBuild,
  resetCodingPlanUpgradeMockServer,
  startCodingPlanUpgradeMockServer,
} from "../helpers/coding-plan-upgrade-mock-server.js";
import { restoreE2EProviderEndpointEnv } from "./mocks-upstream.js";
import {
  E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  REPO_ROOT,
} from "./paths.js";
import {
  isOffPeakInvalidTicketSpec,
  isOffPeakSubagentModelInheritanceSpec,
} from "./seeding-subagents.js";
import { wdioState } from "./state.js";

export async function startCodingPlanUpgradeE2EMock(
  specs: string[] = [],
  options: { prepareForBuild?: boolean } = {},
) {
  const resolvedScenario = resolveCodingPlanUpgradeMockScenario(specs);
  const scenario =
    resolvedScenario ??
    (options.prepareForBuild && shouldPrepareCodingPlanUpgradeMockForBuild(specs)
      ? "webview-refresh-provider"
      : null);
  if (!scenario) {
    await stopCodingPlanUpgradeE2EMock();
    return;
  }
  const preparedBaseUrl = process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
  const mockOptions = { marketingTouch: specs.some((spec) => spec.includes("marketing-touch-")) };
  if (!wdioState.codingPlanUpgradeMockServer && preparedBaseUrl) {
    await resetCodingPlanUpgradeMockServer(preparedBaseUrl, scenario, mockOptions);
    applyCodingPlanUpgradeMockEnv(process.env, preparedBaseUrl);
    return;
  }
  if (wdioState.codingPlanUpgradeMockServer) {
    await resetCodingPlanUpgradeMockServer(
      wdioState.codingPlanUpgradeMockServer.baseUrl,
      scenario,
      mockOptions,
    );
    applyCodingPlanUpgradeMockEnv(process.env, wdioState.codingPlanUpgradeMockServer.baseUrl);
    return;
  }
  wdioState.codingPlanUpgradeMockServer = await startCodingPlanUpgradeMockServer(
    scenario,
    mockOptions,
  );
  process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] =
    wdioState.codingPlanUpgradeMockServer.baseUrl;
  applyCodingPlanUpgradeMockEnv(process.env, wdioState.codingPlanUpgradeMockServer.baseUrl);
}

// 闲时任务 E2E：off-peak spec 命中时开进程内 mock 网关（ZCODE_OFFPEAK_MOCK=1），
// host 继承 worker env 后自动起网关、灰度强制开启；管理类 GUI spec 保持票据短暂 queued，
// 避免创建落库唤醒 scheduler 后在 UI 来得及操作前就派发模型请求。
export async function startOffPeakE2EMock(specs: string[] = []): Promise<void> {
  const isOffPeakSpec = specs.some((spec) => spec.includes("off-peak") || spec.includes("offpeak"));
  if (isOffPeakSpec) {
    process.env.ZCODE_OFFPEAK_MOCK = "1";
    process.env.ZCODE_OFFPEAK_MOCK_PORT = "45197";
    const isSubagentInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
    const isInvalidTicketSpec = isOffPeakInvalidTicketSpec(specs);
    // 管理类 case 延后 ready；OP10 必须真跑 scheduler→turn→child，因此取号即 ready。
    process.env.ZCODE_OFFPEAK_MOCK_READY_DELAY_MS =
      isSubagentInheritanceSpec || isInvalidTicketSpec ? "0" : "60000";
    process.env.ZCODE_OFFPEAK_MOCK_READY_TTL_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_ACTIVE_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_NEXT_POLL_S = "1";
    if (isSubagentInheritanceSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else if (isInvalidTicketSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "invalid-ticket";
    } else if (
      specs.some((spec) =>
        spec.includes("conversation-session-offpeak-create-existing-session.test.ts"),
      )
    ) {
      // 绑定会话复用已有固定文本响应，保留 queued 编辑窗口；capture 模式会继续
      // 转发上游，不适合作为此例的离线应答。fixture 只匹配一个 child marker，不创建子任务。
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    }
    // D39 回归 spec：专用 availability 返回 false + next_take_at，验证 renderer
    // 使用服务端快照提前置灰；其余 off-peak spec 保持 availability=true。
    const isLimitPreGateSpec = specs.some((spec) => spec.includes("off-peak-limit-pre-gate"));
    if (isLimitPreGateSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS = "3600000";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    }
    await materializeOffPeakMockZCodeBuiltinProviderConfig(
      Number(process.env.ZCODE_OFFPEAK_MOCK_PORT),
      isSubagentInheritanceSpec ? "GLM-5.3" : "GLM-5.2",
    );
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  } else {
    delete process.env.ZCODE_OFFPEAK_MOCK;
    delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    delete process.env.ZCODE_OFFPEAK_MOCK_PORT;
    delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    if (INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    } else {
      delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    }
  }
}

async function materializeOffPeakMockZCodeBuiltinProviderConfig(
  port: number,
  modelId: string,
): Promise<void> {
  const sourcePath = resolve(REPO_ROOT, "config/provider/zcode-builtin.json");
  const document = JSON.parse(await readFile(sourcePath, "utf8")) as {
    config?: {
      providerConfigRules?: {
        providerRules?: Array<{
          providerId: string;
          config: { api?: { baseUrl?: string }; builtinModelIds?: string[] };
        }>;
      };
    };
  };
  const offPeakProviderIds = [
    "account:zai-offpeak-idle-plan",
    "account:bigmodel-offpeak-idle-plan",
  ];
  for (const providerId of offPeakProviderIds) {
    // Built-in 已收敛到规则列表；旧夹具读 providers 会在启动前报缺少 api。
    const offPeakProvider = document.config?.providerConfigRules?.providerRules?.find(
      (rule) => rule.providerId === providerId,
    )?.config;
    if (!offPeakProvider?.api) {
      throw new Error(`ZCode Built-in Config 缺少 ${providerId}.api`);
    }
    offPeakProvider.api.baseUrl = `http://127.0.0.1:${port}/api/v1/off-peak/anthropic`;
    // 原闲时 fixture 的单模型白名单应迁到当前 Built-in 输入，不能继续依赖已退役的
    // client-config models 字段；仅修改本次 E2E 隔离文件，生产名单不变。
    offPeakProvider.builtinModelIds = [modelId];
  }
  await mkdir(resolve(E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, ".."), {
    recursive: true,
  });
  await writeFile(
    E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

// Highspeed E2E 使用 Host 内置的确定性 transport；按 spec 注入场景，避免普通会话
// 在默认测试套件里意外抽到卡。该变量必须在 Electron 启动前设置，Host 才能装配 mock。
export function configureHighspeedE2EMock(specs: string[] = []): void {
  const scenario = resolveHighspeedE2EMockScenario(specs);
  if (scenario) {
    process.env[HIGHSPEED_MOCK_SCENARIO_ENV] = scenario;
  } else {
    delete process.env[HIGHSPEED_MOCK_SCENARIO_ENV];
  }
}

export async function stopCodingPlanUpgradeE2EMock() {
  const ownedBaseUrl =
    wdioState.codingPlanUpgradeMockServer?.baseUrl ??
    process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim() ??
    "";
  if (!wdioState.codingPlanUpgradeMockServer) {
    if (ownedBaseUrl) {
      clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
    }
    restoreE2EProviderEndpointEnv();
    return;
  }
  await wdioState.codingPlanUpgradeMockServer.stop();
  wdioState.codingPlanUpgradeMockServer = null;
  clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
  restoreE2EProviderEndpointEnv();
}
