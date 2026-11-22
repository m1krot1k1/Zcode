import { mkdirSync, writeFileSync } from "node:fs";
import { resolveE2EWorkerModelStreamIdleTimeoutMs } from "../helpers/e2e-worker-isolation.js";
import {
  type PersonalProviderConfigSeed,
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
} from "../helpers/model-provider-restart-config.js";
import {
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
  CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
} from "../helpers/provider-readiness-history-fixture.js";
import { E2E_PROVIDER_REPLAY_API_KEY } from "./env.js";
import {
  E2E_APP_CONFIG_DIR,
  E2E_APP_PROVIDER_CONFIG_FILE,
  E2E_CLI_CONFIG_DIR,
  E2E_CLI_CONFIG_FILE,
} from "./paths.js";
import { usesContextWindowColdResumeFixture } from "./seeding-spec-fixtures.js";
import { seedUpstreamE2EModelConfig } from "./seeding-subagents.js";
import {
  MODEL_OUTPUT_TOKEN_BUDGET_SPEC,
  MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC,
  OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC,
} from "./specs.js";
import { wdioState } from "./state.js";

export async function seedE2EModelConfig(specs: string[] = []) {
  if (usesContextWindowColdResumeFixture(specs)) {
    await seedContextWindowColdResumeModelConfig();
    return;
  }
  await seedUpstreamE2EModelConfig(specs);
  await seedModelOutputTokenProviders(specs);
}

interface ModelOutputTokenProviderSeed {
  apiFormat?: "openai-chat-completions" | "openai-responses";
  id: string;
  kind?: "openai" | "openai-compatible";
  models: Array<{
    contextWindow: number;
    id: string;
    limitOutput?: number;
    maxOutputTokens?: number;
  }>;
  name: string;
  supportedFormat?: "openai" | "responses";
}

export function seedE2EWorkerModelStreamConfig(specs: string[] = []) {
  const modelStreamIdleTimeoutMs = resolveE2EWorkerModelStreamIdleTimeoutMs(specs);
  if (modelStreamIdleTimeoutMs === undefined) return;
  mkdirSync(E2E_CLI_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_CLI_CONFIG_FILE,
    JSON.stringify({ modelStream: { idleTimeoutMs: modelStreamIdleTimeoutMs } }, null, 2),
    "utf-8",
  );
}

async function seedModelOutputTokenProviders(specs: string[] = []) {
  const providerSeeds: ModelOutputTokenProviderSeed[] = [];
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_BUDGET_SPEC))) {
    providerSeeds.push({
      id: "output-token-budget-e2e",
      models: [
        { contextWindow: 128_000, id: "otb-default" },
        { contextWindow: 128_000, id: "otb-16k", limitOutput: 16_000 },
        { contextWindow: 128_000, id: "otb-64k", maxOutputTokens: 64_000 },
        { contextWindow: 128_000, id: "otb-runtime-refresh" },
      ],
      name: "Output Token Budget E2E",
    });
  }
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC))) {
    providerSeeds.push({
      id: "output-token-preflight-e2e",
      models: [
        {
          contextWindow: 128_000,
          id: "otb-preflight-64k",
          limitOutput: 64_000,
        },
        {
          contextWindow: 64_000,
          id: "otb-preflight-smoke-64k-48k",
          limitOutput: 48_000,
        },
        {
          contextWindow: 200_000,
          id: "otb-preflight-smoke-200k-128k",
          limitOutput: 128_000,
        },
      ],
      name: "Output Token Preflight E2E",
    });
  }
  if (specs.some((spec) => spec.includes(OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC))) {
    providerSeeds.push(
      {
        id: "otc-protocol-chat",
        models: [{ contextWindow: 128_000, id: "otc-protocol-chat" }],
        name: "OTC Chat Completions E2E",
      },
      {
        apiFormat: "openai-responses",
        id: "otc-protocol-responses",
        kind: "openai",
        models: [{ contextWindow: 128_000, id: "otc-protocol-responses" }],
        name: "OTC Responses API E2E",
        supportedFormat: "responses",
      },
    );
  }
  if (providerSeeds.length === 0) {
    return;
  }

  const apiKey =
    wdioState.upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("Output-token E2E 缺少可用 provider API Key");
  }
  const appProviders = providerSeeds.map(
    (provider): PersonalProviderConfigSeed => ({
      apiFormat: "openai-chat-completions",
      apiKey,
      baseURL: wdioState.upstreamE2EBaseUrl,
      enabled: true,
      id: provider.id,
      label: provider.name,
      models: provider.models.map((model) => ({
        contextWindow: model.contextWindow,
        id: model.id,
        ...(model.maxOutputTokens === undefined && model.limitOutput === undefined
          ? {}
          : { maxOutputTokens: model.maxOutputTokens ?? model.limitOutput }),
      })),
    }),
  );
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
}

async function seedContextWindowColdResumeModelConfig() {
  const apiKey =
    wdioState.upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("context-window cold-resume 缺少可用 provider API Key");
  }
  const provider: PersonalProviderConfigSeed = {
    id: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    label: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
    baseURL: wdioState.upstreamE2EBaseUrl,
    apiFormat: "openai-chat-completions",
    apiKey,
    enabled: true,
    models: [
      {
        id: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
        contextWindow: CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
        maxOutputTokens: CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
      },
    ],
  };
  await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    modelId: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  });
}
