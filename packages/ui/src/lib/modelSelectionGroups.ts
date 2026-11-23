import {
  isEmbeddingOnlyModelId,
  isZCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

/**
 * 把有效上下文窗口格式化成模型菜单徽标：1_000_000 → 1M，200_000 → 200K。
 * 未知、非正数或非有限值不展示，避免把缺省值写成配置事实。
 */
export function formatContextWindowLabel(contextWindow: number | null | undefined): string {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "";
  }
  if (contextWindow >= 1_000_000) {
    return `${formatScaledContextValue(contextWindow / 1_000_000)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${formatScaledContextValue(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

function formatScaledContextValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function supportsRegistryApiFormat(
  providerId: string,
  accessType: string | null | undefined,
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 根因：旧 OpenCode 目录在 Composer 之外单独拼组并走 ACP，模型选择没有写入标准 ModelSelection。
  // local-auth + SDK 类型现在由 Host 注册为普通 Provider，因此只按明确协议组合纳入公共目录。
  if (providerId === "opencode") return accessType === "local-auth" && apiFormat === "opencode-sdk";
  // Cursor CLI публикуется Host-ом как обычный local-auth Provider с api.type "cursor-cli";
  // других комбинаций у него нет, поэтому допускаем только эту пару.
  if (providerId === "cursor") return accessType === "local-auth" && apiFormat === "cursor-cli";
  // Cursor/OpenCode selectedProvider describes the active local CLI, not the only
  // provider allowed in the catalog. Standard OpenAI/Anthropic registry providers must
  // remain selectable while a CLI is active; otherwise a downloaded local model
  // disappears from the composer until the user switches to the ZCode agent.
  return (
    isZCodeAgentProvider(selectedProvider) ||
    apiFormat === "openai-chat-completions" ||
    apiFormat === "anthropic-messages" ||
    apiFormat === "openai-responses"
  );
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  return view.providers.flatMap((provider) => {
    if (
      !supportsRegistryApiFormat(
        provider.providerId,
        provider.config.access?.type,
        selectedProvider,
        provider.config.api?.type,
      )
    ) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    // 合并菜单仍需区分同名供应商的接入方式；API 标识直接来自 access，不能从名称猜测。
    const localCliProvider = provider.providerId === "opencode" || provider.providerId === "cursor";
    const labelBadge =
      (localCliProvider ? "CLI" : undefined) ??
      accountPresentation?.labelBadge ??
      (provider.config.access?.type === "api-key" ||
      provider.config.access?.type === "zhipu-coding-plan-api-key"
        ? (labels.apiKeyBadgeLabel ?? "API")
        : undefined);

    // Embedding-модели не умеют вести чат; не показываем их в каталоге Composer,
    // иначе bge-m3 можно выбрать как обычную модель и получить 400 при отправке.
    const chatModels = provider.models.filter(({ modelId }) => !isEmbeddingOnlyModelId(modelId));
    if (chatModels.length === 0) return [];

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(provider.config.logo ? { logo: provider.config.logo } : {}),
        ...(labelBadge ? { labelBadge } : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: chatModels.map(({ modelId, config }) => {
          // 上下文窗口来自有效配置；未知值不渲染徽标，避免把缺省值写成事实。
          const contextBadgeLabel = formatContextWindowLabel(config.properties?.contextWindow);
          return {
            key: `registry-provider:${provider.providerId}:${modelId}`,
            value: encodeCustomModelValue(provider.providerId, modelId),
            name: config.properties?.displayName ?? modelId,
            ...(contextBadgeLabel ? { badgeLabel: contextBadgeLabel } : {}),
            ...(shouldShowModelVisionBadge(
              modelId,
              config.properties?.inputFormat?.supportsImage,
              provider.config.access,
            )
              ? { supportsVisionInput: true }
              : {}),
          };
        }),
      },
    ];
  });
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
