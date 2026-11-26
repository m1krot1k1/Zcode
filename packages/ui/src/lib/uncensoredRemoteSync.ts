import type {
  ZCodeUncensoredGetConfigResult,
  ZCodeUncensoredProviderStatus,
  ZCodeUncensoredSettingsWrite,
} from "@zcode/shared";

/**
 * Настройки нецензурированных провайдеров и их mirror-провайдеры живут на том Host,
 * который обслуживает настройки (локальный). Агент удалённого workspace работает на
 * удалённом Host и читает собственный реестр провайдеров, поэтому без переноса:
 * - композер удалённого workspace не видит mirror-модель (список пуст);
 * - takeover на удалённом Host получает `no-enabled-models`.
 *
 * Перенос идёт ровно в один Host — целевой Environment активного workspace, тем же
 * `updateConfig`, что и обычное сохранение: он и зеркалит провайдеров, и пишет секрет
 * в credential store целевого Host. Сравнение по имени и моделям не даёт перезаписывать
 * удалённый реестр на каждом монтировании.
 */

export type UncensoredRemoteSyncOutcome = "not-remote" | "unchanged" | "synced" | "empty";

export interface UncensoredRemoteSyncPorts {
  readLocal(): Promise<ZCodeUncensoredGetConfigResult>;
  readTarget(): Promise<{ providers: readonly ZCodeUncensoredProviderStatus[] }>;
  writeTarget(write: ZCodeUncensoredSettingsWrite): Promise<unknown>;
  refreshTarget(): Promise<unknown>;
}

function providerSignature(provider: { name: string; models: readonly { id: string }[] }): string {
  return `${provider.name}\u0000${provider.models.map((model) => model.id).join("\u0001")}`;
}

function configSignature(
  providers: readonly { name: string; models: readonly { id: string }[] }[],
) {
  return providers.map(providerSignature).sort().join("\u0002");
}

export async function syncUncensoredSettingsToTarget(
  ports: UncensoredRemoteSyncPorts,
): Promise<UncensoredRemoteSyncOutcome> {
  const local = await ports.readLocal();
  if (local.providers.length === 0) return "empty";

  const target = await ports.readTarget();
  if (configSignature(local.providers) === configSignature(target.providers)) {
    return "unchanged";
  }

  await ports.writeTarget({
    providers: local.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      apiUrl: provider.apiUrl,
      // Пустой ключ на целевом Host означает «не настроен», а не «стереть»: источник —
      // единственный, кто знает секрет, поэтому всегда передаём его значение.
      apiKey: provider.apiKey ?? null,
      models: provider.models.map((model) => ({ id: model.id, enabled: model.enabled })),
    })),
  });
  await ports.refreshTarget();
  return "synced";
}
