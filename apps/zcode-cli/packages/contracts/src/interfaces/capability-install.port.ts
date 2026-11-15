/** Capability kinds that can be installed without changing the agent profile. */
export type CapabilityInstallKind = "mcp" | "plugin";

export interface CapabilityInstallRequest {
  kind: CapabilityInstallKind;
  id: string;
  /** MCP: transport config; plugin: optional marketplace metadata. */
  config?: Record<string, unknown>;
  marketplace?: string;
  pluginName?: string;
  scope?: "user" | "workspace";
}

export interface CapabilityInstallResult {
  kind: CapabilityInstallKind;
  id: string;
  status: "installed" | "already_installed";
  /** True when the capability needs a host/session reload before its tools are visible. */
  requiresReload?: boolean;
  evidence?: string;
}

/**
 * Host-owned installer for environment capabilities (MCP servers, plugins).
 * The tool handler is gated by user approval; this port performs the actual
 * connect/install and reports whether the capability is usable.
 */
export interface CapabilityInstallPort {
  isInstalled(kind: CapabilityInstallKind, id: string): Promise<boolean>;
  install(
    request: CapabilityInstallRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CapabilityInstallResult>;
}
