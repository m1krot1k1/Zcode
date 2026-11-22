/**
 * Общие контракты Coding Plan usage-панели.
 *
 * Вынесено из CodingPlanUsagePanel.tsx при разбиении файла: здесь только
 * формы props и типы, разделяемые хуком состояния, секциями и внешним
 * потребителем через реэкспорт из исходного модуля.
 */
import type {
  CodingPlanUsageRange,
  UsageQuotaLimit,
  UsageQuotaSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { CodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";

export type CodingPlanUsageTrendRange = Extract<
  CodingPlanUsageRange,
  "7d" | "30d"
>;

/** Источник account access приходит из shared-протокола, не из сервисов. */
export type CodingPlanUsageAccountAccess =
  | ZCodeProviderAccountAccess
  | ZCodeAccountAccess
  | undefined;

export interface CodingPlanUsagePanelProps {
  loadingSources: boolean;
  selectedSource?: CodingPlanUsageSource | null;
  workspaceIdentity?: string;
  workspacePath?: string;
}

export interface CodingPlanQuotaCard {
  key: string;
  label: string;
  limit: UsageQuotaLimit;
  progressColor: string;
}

export interface CodingPlanQuotaCardsProps {
  quota: UsageQuotaSnapshot | null;
  /** 官方 Server MCP 额度不在 quota.limits[] 里，由 entitlement 快照的独立字段传入。 */
  mcpQuotaLimit: UsageQuotaLimit | null;
  generatedAt: number;
  sourceKey: string | undefined;
  preferredProviderId: string | undefined;
  accountAccess: CodingPlanUsageAccountAccess;
  onEntitlementRefresh: () => void | Promise<void>;
  onUsageStatsRefresh: () => void | Promise<void>;
}
