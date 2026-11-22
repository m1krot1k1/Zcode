import type { PluginSyncComponentType } from "@zcode/shared";

export interface PluginManifestInfo {
  name: string;
  pluginId: string;
  description?: string;
  version?: string;
  componentTypes: PluginSyncComponentType[];
}

export interface UserPluginConfigState {
  dirs: string[];
  enabledOverrides: Map<string, boolean>;
}

export interface MarketplaceManifestInfo {
  name: string;
  description?: string;
  pluginRoot?: string;
  plugins: MarketplacePluginEntryInfo[];
  raw: Record<string, unknown>;
}

export interface MarketplacePluginEntryInfo {
  name: string;
  dependencies: string[];
  raw: Record<string, unknown>;
  source?: unknown;
}

export interface MarketplaceSourceLoadResult {
  manifest: MarketplaceManifestInfo;
  sourceRoot?: string;
}

export interface MarketplaceSourceMirrorEntry {
  entry: MarketplacePluginEntryInfo;
  mirroredSourcePath?: string;
  mirroredSourceRelativePath?: string;
}
