/**
 * process-manager/logging.ts: Единый logger менеджера процессов агента.
 */
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

const serviceLog = createServiceLogger("zcode-agent");

export const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
export const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
export const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

export const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};
