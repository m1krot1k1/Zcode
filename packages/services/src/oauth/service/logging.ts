import { formatLogPrefix } from "@zcode/shared";
import { createServiceLogger } from "../../logger/serviceLogger.js";

export const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);

export const serviceLog = createServiceLogger("oauthService");
