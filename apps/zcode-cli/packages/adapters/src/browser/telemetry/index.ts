/**
 * cli-browser-telemetry — публичный вход модуля.
 * Всё, что не экспортировано здесь, считается внутренним.
 */
export type {
  BrowserDialogPolicy,
  BrowserObservationRequest,
  BrowserTelemetryController,
  BrowserTelemetryOptions,
} from "./contract.js";
export { BROWSER_TELEMETRY_DEFAULTS } from "./contract.js";
export { createBrowserTelemetryController } from "./collector.js";
