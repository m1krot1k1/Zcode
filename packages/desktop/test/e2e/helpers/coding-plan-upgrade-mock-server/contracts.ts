export type CodingPlanUpgradeMockScenario =
  | "manual-claim-experience"
  | "personal-sold-out"
  | "personal-system-busy"
  | "webview-refresh-provider";

export interface CodingPlanUpgradeMockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  keyCreation?: { name?: unknown; usageScene?: unknown };
}

export interface CodingPlanUpgradeMockServer {
  baseUrl: string;
  scenario: CodingPlanUpgradeMockScenario;
  stop(): Promise<void>;
}

export interface CodingPlanUpgradeMockState {
  webviewMode: "hold" | "fail" | "ready";
  webviewWaiters: Array<() => void>;
  customerInfoHeld: boolean;
  customerInfoWaiters: Array<() => void>;
  inventoryMode: "hold" | "fail" | "ready";
  inventoryWaiters: Array<() => void>;
  clientConfigPayload: CodingPlanClientConfigFixture;
  manualClaimBucketReady: boolean;
  manualClaimCompleted: boolean;
  manualClaimShouldFail: boolean;
  startPlanExpired: boolean;
  purchaseCompleted: boolean;
  scenario: CodingPlanUpgradeMockScenario;
}

export interface CodingPlanClientConfigFixture {
  data: {
    builtinProviders?: Array<{
      id?: string;
      name?: string;
      schema?: string;
      baseUrl?: string;
      models?: string[];
    }>;
    builtinModels?: Array<{
      modelId: string;
      name?: string;
      contextWindow?: number;
      maxCompletionTokens?: number;
      priority?: number;
    }>;
    configs: {
      codingPlanStaticProducts: Partial<
        Record<
          string,
          Array<{
            productId: string;
            productName: string;
            priceUnit: "month" | "quarter" | "year";
            payAmount?: number;
          }>
        >
      >;
    };
  };
}

const DEFAULT_FULL_E2E_SPEC_GLOB = "./test/e2e/**/*.test.ts";

export function resolveCodingPlanUpgradeMockScenario(
  specs: readonly string[],
): CodingPlanUpgradeMockScenario | null {
  if (specs.some((spec) => spec.includes("marketing-touch-"))) {
    return "manual-claim-experience";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-system-busy"))) {
    return "personal-system-busy";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-sold-out"))) {
    return "personal-sold-out";
  }
  if (
    specs.some(
      (spec) =>
        spec.includes("coding-plan-upgrade-webview-refresh-provider") ||
        spec.includes("account-key-usage-scene"),
    )
  ) {
    return "webview-refresh-provider";
  }
  return null;
}

export function shouldPrepareCodingPlanUpgradeMockForBuild(specs: readonly string[]): boolean {
  return (
    resolveCodingPlanUpgradeMockScenario(specs) !== null ||
    specs.some((spec) => spec.replace(/\\/gu, "/") === DEFAULT_FULL_E2E_SPEC_GLOB)
  );
}

export function isCodingPlanUpgradeMockScenario(
  value: unknown,
): value is CodingPlanUpgradeMockScenario {
  return (
    value === "manual-claim-experience" ||
    value === "personal-sold-out" ||
    value === "personal-system-busy" ||
    value === "webview-refresh-provider"
  );
}
