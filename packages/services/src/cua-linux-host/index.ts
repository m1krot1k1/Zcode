/**
 * services-cua-linux-host — публичный вход модуля.
 * Всё, что не экспортировано здесь, считается внутренним.
 */
export type {
  LinuxCuaCaptureOptions,
  LinuxCuaCapabilityReport,
  LinuxCuaClickOptions,
  LinuxCuaFrame,
  LinuxCuaHostContract,
  LinuxCuaKeyOptions,
  LinuxCuaMouseButton,
  LinuxCuaOperation,
  LinuxCuaOperationResult,
  LinuxCuaPointerMoveOptions,
  LinuxCuaScreenshotPermission,
  LinuxCuaScrollOptions,
  LinuxCuaTypeOptions,
  LinuxCuaUnavailableReason,
  LinuxDisplayBackend,
  LinuxDisplayProbeResult,
  LinuxInputProvider,
  LinuxScreenCaptureProvider,
} from "./contract.js";
export { LINUX_CUA_DEFAULTS } from "./contract.js";
export { createLinuxCuaHost, LinuxCuaHost, type LinuxCuaHostOptions } from "./linux-cua-host.js";
export {
  probeWaylandRemoteDesktopPortal,
  createWaylandRemoteDesktopSession,
  type WaylandPortalAvailability,
  type WaylandPortalSession,
} from "./wayland-portal-client.js";
export { probeX11Ffi, X11KoffiInput } from "./x11-koffi-input.js";
