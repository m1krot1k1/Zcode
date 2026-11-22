import type {
  ZCodePluginInfo,
  ZCodePluginOptionValue,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import type { RemotePluginSyncPluginOptions } from "@/settings/remote-plugin-sync-dialog/types.js";

function isPathPluginOption(option: ZCodePluginUserConfigOption | undefined): boolean {
  return option?.type === "file" || option?.type === "directory";
}

export function isPortablePluginOptionValue(
  value: ZCodePluginOptionValue,
  localOption: ZCodePluginUserConfigOption | undefined,
  remoteOption: ZCodePluginUserConfigOption | undefined,
): boolean {
  if (!localOption || !remoteOption) {
    return false;
  }
  if (localOption.sensitive === true || remoteOption.sensitive === true) {
    return false;
  }
  if (isPathPluginOption(localOption) || isPathPluginOption(remoteOption)) {
    return false;
  }
  const expectedType = remoteOption.type ?? localOption.type;
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "number") return typeof value === "number";
  if (expectedType === "string") return typeof value === "string";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function buildPortablePluginOptionsSyncPlan(
  localOptions: RemotePluginSyncPluginOptions,
  remotePlugin: ZCodePluginInfo,
): { options: Record<string, ZCodePluginOptionValue>; skippedCount: number } {
  const options: Record<string, ZCodePluginOptionValue> = {};
  let skippedCount = 0;
  for (const [key, value] of Object.entries(localOptions.configuredOptions)) {
    if (
      isPortablePluginOptionValue(
        value,
        localOptions.userConfig[key],
        remotePlugin.userConfig?.[key],
      )
    ) {
      options[key] = value;
    } else {
      skippedCount += 1;
    }
  }
  return { options, skippedCount };
}

export function arePluginOptionsEqual(
  left: Record<string, ZCodePluginOptionValue>,
  right: Record<string, ZCodePluginOptionValue>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}
