// Сайд-таблицы Node-входа services, привязанные к ServiceCollection.
// Вынесено из node.ts: доступ к WeakMap-реестрам нужен и регистрации, и dispose-цепочке.
import type { ServiceCollection } from "../collection.js";
import type { HostApiNetworkTransport } from "../providers/api/nodeApiNetwork.js";
import type { ProviderProvisioningSource } from "../model-provider/providerProvisioningSource.js";
import type { ProviderRuntime } from "../model-provider/providerRuntime.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

export function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

export function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// 默认 Computer Use Helper 是长生命周期的独立 TCC 授权进程（持 broker socket + Accessibility/Screen Recording）。
// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
export const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
export const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
export const providerProvisioningSources = new WeakMap<
  ServiceCollection,
  ProviderProvisioningSource
>();
export const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// 自动归档定时扫描器不是 IPC 服务，随 services 释放时停掉定时器与设置监听。
export const taskAutoArchiveDisposers = new WeakMap<ServiceCollection, () => void>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
export const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
export const accountRequestAuthServices = new WeakMap<
  ServiceCollection,
  IAccountRequestAuthService
>();
export type OffPeakRequestAuthBuilder = (ticketId: string) => Promise<{
  apiKey: string;
  headers: Record<string, string>;
  accountScope?: string;
}>;
export const offPeakRequestAuthBuilders = new WeakMap<
  ServiceCollection,
  OffPeakRequestAuthBuilder
>();

/** Local Host 进程内能力；不会随 ServiceCollection 暴露到通用 RPC Channel。 */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local Host 私有的闲时请求鉴权装配；复用正式 Registry/Account Access 解析，不进入 RPC。 */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
export const managedHostApiNetworkTransports = new WeakMap<
  ServiceCollection,
  HostApiNetworkTransport
>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

/** Регистрация приватных Node-возможностей в сайд-таблицах конкретного ServiceCollection. */
export function setAccountRequestAuthService(
  services: ServiceCollection,
  service: IAccountRequestAuthService,
): void {
  accountRequestAuthServices.set(services, service);
}

export function setOffPeakRequestAuthBuilder(
  services: ServiceCollection,
  builder: OffPeakRequestAuthBuilder,
): void {
  offPeakRequestAuthBuilders.set(services, builder);
}

export function setProviderRuntime(services: ServiceCollection, runtime: ProviderRuntime): void {
  providerRuntimes.set(services, runtime);
}

export function setProviderProvisioningSource(
  services: ServiceCollection,
  source: ProviderProvisioningSource,
): void {
  providerProvisioningSources.set(services, source);
}

export function setProviderProvisioningTriggerDisposers(
  services: ServiceCollection,
  disposers: readonly (() => void)[],
): void {
  providerProvisioningTriggerDisposers.set(services, disposers);
}

export function setTaskAutoArchiveDisposer(
  services: ServiceCollection,
  disposer: () => void,
): void {
  taskAutoArchiveDisposers.set(services, disposer);
}

export function setSharedSqliteRepos(
  services: ServiceCollection,
  repos: ReadonlyArray<{ close(): void }>,
): void {
  sharedSqliteRepos.set(services, repos);
}
