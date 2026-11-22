import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type BuiltinModelProviderId,
  type StartPlanPreviewConfig,
} from "@zcode/shared";
import { ArrowRightIcon, AstroidIcon, UsersIcon } from "lucide-react";
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanProviderId, CodingPlanStatus } from "../constants.js";
import { resolveCodingPlanUpgradeProductsProviderId } from "../codingPlanPricingCards.js";
import type {
  EnterpriseCodingPlanProductGroup,
  PurchaseAudience,
} from "../codingPlanEnterpriseTiers.js";
import {
  formatCodingPlanAmount,
  pickProductPrice,
  type CodingPlanProductDisplay,
} from "../codingPlanProductPresentation.js";
import { resolveStartPlanEntitlementSummary } from "../StartPlanCard.js";
import { useCodingPlanProducts } from "../useCodingPlanProducts.js";
import { useEnterpriseCodingPlanProducts } from "../useEnterpriseCodingPlanProducts.js";

const START_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,var(--color-success)_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,var(--color-success)_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const PERSONAL_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#4099ff_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#4099ff_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const TEAM_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#0ea5e9_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#0ea5e9_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";

export function resolvePurchaseChoiceSelectionIntent(
  status: CodingPlanStatus,
): "login" | "purchase" {
  return status === "disconnected" ? "login" : "purchase";
}

export function CodingPlanPurchaseChoiceBanners({
  providerId,
  startPlanPreview = null,
  personalVisible = true,
  teamVisible = true,
  soldOutVisible = false,
  accountDisconnected = false,
  onSelect,
  onSelectStartPlan,
}: {
  providerId: CodingPlanProviderId;
  startPlanPreview?: StartPlanPreviewConfig | null;
  personalVisible?: boolean;
  teamVisible?: boolean;
  soldOutVisible?: boolean;
  accountDisconnected?: boolean;
  onSelect: (
    audience: PurchaseAudience,
    options?: { initialTeamPlanKey?: string; eventText?: string },
  ) => void;
  onSelectStartPlan?: () => void;
}) {
  const entryGate = useCodingPlanEntryGate();
  const { intl, locale } = useZCodeIntl();
  const startPlanSummary = startPlanPreview
    ? resolveStartPlanEntitlementSummary(startPlanPreview, intl, locale)
    : null;
  // Start Plan 只是免费入口，入口价格必须读取对应付费 Coding Plan 的商品源；
  // 否则这里拿到免费 SKU/空列表后会隐藏对应付费 Coding Plan 的起售价。
  const pricingProviderId = resolvePurchaseChoiceBannerProductsProviderId(providerId);
  const staticProducts = useCodingPlanProducts(pricingProviderId, {
    remotePreviewEnabled: false,
  });
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    // 未登录也必须读取静态团队目录；售罄可见性不能充当目录加载开关。
    enabled:
      teamVisible && pricingProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    authenticated: soldOutVisible,
    staticOnly: !soldOutVisible,
  });
  const personalPrice = resolvePurchaseChoiceBannerPrice({
    providerId: pricingProviderId,
    audience: "personal",
    products: staticProducts.snapshot?.productList ?? [],
    soldOutVisible,
  });
  // 团队入口只展示一个横幅，价格来自已配置商品的最低价，不按档位拆成多个入口。
  const teamPrice = resolveEnterprisePurchaseChoiceBannerPrice({
    key: "team",
    title: "",
    products: enterpriseProducts.error
      ? []
      : (enterpriseProducts.snapshot?.productList ?? []).filter((product) =>
          enterpriseProducts.snapshot?.staticProductIds?.includes(product.productId),
        ),
  });
  const startPlanTitle = resolveStartPlanPurchaseChoiceBannerTitle({
    fallbackTitle: intl.formatMessage({
      id: "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle",
    }),
    locale,
    remoteTitle: startPlanPreview?.name,
  });
  const bannerItems = [
    ...(startPlanPreview && startPlanSummary
      ? [
          {
            key: "startPlan" as const,
            label: startPlanTitle,
            description: startPlanSummary.detailsDescription,
            metric: startPlanSummary.grantUnitsLabel,
            metricUnit: startPlanSummary.unitLabel,
            priceState: null,
            className: START_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-success",
            onClick: onSelectStartPlan,
          },
        ]
      : []),
    ...(personalVisible && personalPrice !== null
      ? [
          {
            key: "personal" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: personalPrice,
            className: PERSONAL_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-[#4099ff]",
            onClick: () => onSelect("personal"),
          },
        ]
      : []),
    // 历史订阅记录不决定购买入口可见性；团队 banner 沿用静态目录价格。
    ...(teamVisible && teamPrice !== null
      ? [
          {
            key: "team" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: teamPrice,
            className: TEAM_PLAN_ENTRY_BANNER_CLASS,
            Icon: UsersIcon,
            iconClassName: "text-warning",
            onClick: () => onSelect("team"),
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      {bannerItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={item.className}
          disabled={
            !accountDisconnected && item.key !== "startPlan" && entryGate.status === "loading"
          }
          onClick={() => {
            if (!accountDisconnected && item.key !== "startPlan" && entryGate.status !== "ready") {
              entryGate.retry?.();
              return;
            }
            item.onClick?.();
          }}
        >
          <span className="flex min-w-0 items-start gap-3">
            <item.Icon className={`mt-1 size-4 shrink-0 ${item.iconClassName}`} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-ui-lg font-medium leading-6 text-foreground">
                  {!accountDisconnected && item.key !== "startPlan"
                    ? (entryGate.label ?? item.label)
                    : item.label}
                </span>
              </span>
              {item.metric ? (
                <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-2xl font-bold leading-none text-foreground">
                    {item.metric}
                  </span>
                  {item.metricUnit ? (
                    <span className="text-ui-base font-medium text-foreground-subtle">
                      {item.metricUnit}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {item.priceState?.kind === "price" ? (
                <PurchaseChoiceBannerPrice
                  price={item.priceState.price}
                  currency={item.priceState.currency}
                  locale={locale}
                />
              ) : item.priceState?.kind === "soldOut" ? (
                <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.purchaseBanner.temporarilySoldOut",
                  })}
                </span>
              ) : null}
              <span className="mt-0.5 block text-ui-base leading-5 text-foreground-subtle">
                {item.description}
              </span>
            </span>
            <span className="flex h-6 shrink-0 items-center">
              <ArrowRightIcon className="size-4 text-foreground-subtle" />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function resolvePurchaseChoiceBannerProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  return resolveCodingPlanUpgradeProductsProviderId(providerId) ?? providerId;
}

export function resolvePurchaseChoiceBannerPrice({
  providerId,
  audience,
  products,
  soldOutVisible = true,
}: {
  providerId: BuiltinModelProviderId;
  audience: PurchaseAudience;
  products: CodingPlanProductDisplay[];
  soldOutVisible?: boolean;
}): { kind: "price"; price: number; currency: string } | { kind: "soldOut" } | null {
  if (audience === "personal") {
    const product = products
      .map((candidate) => ({
        product: candidate,
        price: pickProductPrice(candidate),
      }))
      .filter(
        (candidate): candidate is { product: CodingPlanProductDisplay; price: number } =>
          candidate.product.soldOut !== true &&
          typeof candidate.price === "number" &&
          candidate.price > 0,
      )
      .sort((left, right) => left.price - right.price)[0];
    if (product) {
      return {
        kind: "price",
        price: product.price,
        // 商品价格属于 provider 维度，缺失币种时只能按当前 provider 的结算域兜底。
        // 不能让 formatter 默认落到 CNY，否则 Z.ai Global 入口会错误显示 RMB。
        currency:
          product.product.priceCurrency ??
          (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? "CNY" : "USD"),
      };
    }
    if (
      soldOutVisible &&
      products.length > 0 &&
      products.every((candidate) => candidate.soldOut === true)
    ) {
      // 个人套餐入口 banner 是用户进入购买流前看到的第一层价格信息。
      // 所有个人套餐都售罄时需要在金额位置前置展示售罄，而不是继续显示静态最低价。
      return { kind: "soldOut" };
    }
  }

  // 缺失远端商品时不能补造静态价格，否则配置键失配会伪装成正常套餐。

  return null;
}

export function resolveEnterprisePurchaseChoiceBannerPrice(
  group: EnterpriseCodingPlanProductGroup,
): { kind: "price"; price: number; currency: string } | null {
  const product = group.products
    .map((candidate) => ({
      product: candidate,
      price: pickProductPrice(candidate),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        product: EnterpriseCodingPlanProductGroup["products"][number];
        price: number;
      } => typeof candidate.price === "number" && candidate.price > 0,
    )
    .sort((left, right) => left.price - right.price)[0];
  if (!product) {
    return null;
  }
  return {
    kind: "price",
    price: product.price,
    currency: product.product.priceCurrency ?? "CNY",
  };
}

function resolveStartPlanPurchaseChoiceBannerTitle({
  fallbackTitle,
  locale,
  remoteTitle,
}: {
  fallbackTitle: string;
  locale: string;
  remoteTitle?: string;
}): string {
  const title = remoteTitle?.trim() || fallbackTitle;
  if (locale.startsWith("zh") && /^start\s+plan$/i.test(title)) {
    // Start Plan banner 的名称来自远端 preview；当前远端默认只返回英文。
    // 这里只本地化这个已知默认名，避免覆盖真实远端自定义套餐名。
    return fallbackTitle;
  }
  return title;
}

function PurchaseChoiceBannerPrice({
  price,
  currency,
  locale,
}: {
  price: number;
  currency: string | null;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const formattedAmount = formatCodingPlanAmount(price, currency, locale);
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  if (!isChineseLocale) {
    return (
      <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
        {intl.formatMessage(
          { id: "settings.modelProvider.codingPlan.purchase.fromPrice" },
          { price: formattedAmount },
        )}
      </span>
    );
  }

  const [amount, ...labelParts] = formattedAmount.split(" ");
  const label = labelParts.join(" ").trim();
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="text-lg font-semibold leading-6 text-foreground">{amount}</span>
      <span className="text-ui-base font-medium text-foreground-subtle">
        {[
          label,
          intl.formatMessage({
            id: "settings.modelProvider.codingPlan.purchase.fromPriceSuffix",
          }),
        ]
          .filter(Boolean)
          .join(" ")}
      </span>
    </span>
  );
}
