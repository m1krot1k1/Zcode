import {
  resolveWebRemoteControlRelayWsUrl,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
} from "@zcode/shared";
import { generateMobileDeviceFingerprint, setStreamClientId } from "@zcode/ui";

export function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

export function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId =
      globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

export function resolveExternalRelayWsUrl(): string {
  return resolveWebRemoteControlRelayWsUrl({
    endpointOrigin: window.location.origin,
  });
}
