import { resolve } from "node:path";

import { createConfig } from "@zcode/adapters/config";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createRootTraceContext,
  createSessionId,
  traceContextToLogContext,
} from "@zcode/contracts";
import { createModelTelemetry } from "@zcode/telemetry";

import { StartupTimer, startupNow } from "../startup-logging.js";
import {
  createConfigCliOverrides,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import { createSessionBoundary } from "./create-app-boundary.js";
import type { CreateAppDeps, CreateAppState } from "./create-app-contracts.js";
import { prepareAppEnvironment } from "./create-app-env.js";
import { prepareAppModels } from "./create-app-models.js";
import { prepareAppPorts } from "./create-app-ports.js";
import { prepareAppSession } from "./create-app-session.js";
import { createAppSurface } from "./create-app-surface.js";
import { markConfigurationLoaded, startAppStartup } from "./startup-marks.js";
import type { ZCodeApp, ZCodeAppOptions } from "./types.js";

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  const state: CreateAppState = {};
  try {
    const deps: CreateAppDeps = {
      options,
      logger,
      loggerFactory,
      modelLogger,
      modelTelemetry,
      startupTimer,
      configResult,
      traceContext,
      sessionId,
      workingDirectory,
      appVersion,
    };
    const env = await prepareAppEnvironment(deps, state);
    const boundary = createSessionBoundary(deps, env, state);
    const ports = prepareAppPorts(deps, env, boundary);
    const models = await prepareAppModels(deps, env, ports, state);
    const session = prepareAppSession(deps, env, ports, models, boundary, state);
    return createAppSurface({ deps, env, ports, models, session, boundary, state });
  } catch (error) {
    state.providerModelRuntime?.dispose();
    if (state.ownedModelAdapter) {
      void state.ownedModelAdapter.dispose().catch(() => undefined);
    } else if (state.ownedOpenCodeModelRuntime) {
      void state.ownedOpenCodeModelRuntime.dispose().catch(() => undefined);
    }
    void modelTelemetry.shutdown().catch(() => undefined);
    void state.ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
