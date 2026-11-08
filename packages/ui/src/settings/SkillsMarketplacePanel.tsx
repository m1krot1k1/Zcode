import { Loader2, Search } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import type { MarketplaceSkillInfo, SkillSummary } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  marketplaceSkillKey,
  useSkillsMarketplace,
  type SkillInstallScope,
} from "@/hooks/useSkillsMarketplace.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  buildCatalogView,
  CATALOG_TABS,
  type CatalogBadge,
  type CatalogSortMode,
  type CatalogTab,
} from "@/settings/skillsMarketplaceCatalogView.js";

/**
 * 插件商店「技能」页签：搜索 skills.sh 公共目录并安装到工作区或用户目录。
 * 状态全部由 useSkillsMarketplace 持有，安装成功后重跑搜索刷新 installed 标记。
 */
export function SkillsMarketplacePanel({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const marketplace = useSkillsMarketplace({
    workspacePath,
    workspaceIdentity,
  });
  const [draftQuery, setDraftQuery] = useState("");
  const [scope, setScope] = useState<SkillInstallScope>("workspace");
  const [tab, setTab] = useState<CatalogTab>("allTime");
  const [sortMode, setSortMode] = useState<CatalogSortMode>("recommended");
  const sortLabelId = useId();
  const scopeLabelId = useId();
  const scopeLabel = intl.formatMessage({
    id: "settings.plugins.store.skills.scopeLabel",
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void marketplace.search(draftQuery);
  };

  const installing = marketplace.installingKey !== null;
  // 已安装列表与搜索结果互斥渲染：空查询展示目录 + 已安装事实，输入查询后只展示远端结果，
  // 因此同一条技能不会以两份条目同时出现。
  const showInstalled = marketplace.submittedQuery.length === 0;
  const catalogView = useMemo(
    () =>
      buildCatalogView({
        items: marketplace.catalogItems ?? [],
        tab,
        sort: sortMode,
        filter: draftQuery,
      }),
    [marketplace.catalogItems, tab, sortMode, draftQuery],
  );
  // 搜索结果保持服务端命中集合，只做 tab 过滤与排序，不再叠加文本过滤（模糊命中可能不含查询词）。
  const searchView = useMemo(
    () =>
      buildCatalogView({
        items: marketplace.items ?? [],
        tab,
        sort: sortMode,
        filter: "",
        searchResults: marketplace.hasSearched,
      }),
    [marketplace.items, marketplace.hasSearched, tab, sortMode],
  );

  const handleQueryChange = (value: string) => {
    setDraftQuery(value);
    if (!value.trim()) {
      void marketplace.search("");
      return;
    }
    marketplace.scheduleSearch(value);
  };

  const handleClear = () => {
    setDraftQuery("");
    void marketplace.search("");
  };

  return (
    <section
      data-testid="plugin-store-skills"
      className="space-y-4"
      aria-busy={marketplace.loading}
    >
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={handleSubmit}
        aria-label={intl.formatMessage({
          id: "settings.plugins.store.skills.searchPlaceholder",
        })}
      >
        <SettingsSearchInput
          data-testid="plugin-store-skills-search"
          containerClassName="min-w-0 flex-[1_1_16rem]"
          value={draftQuery}
          onChange={(event) => handleQueryChange(event.target.value)}
          onClear={handleClear}
          clearLabel={intl.formatMessage({
            id: "settings.plugins.store.skills.clearSearch",
          })}
          placeholder={intl.formatMessage({
            id: "settings.plugins.store.skills.searchPlaceholder",
          })}
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span id={scopeLabelId} className="text-ui-xs text-foreground-subtle">
              {scopeLabel}
            </span>
            <Select value={scope} onValueChange={(value) => setScope(value as SkillInstallScope)}>
              <SelectTrigger
                size="lg"
                aria-labelledby={scopeLabelId}
                data-testid="plugin-store-skills-scope"
                className="h-9 rounded-xl"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="workspace">
                  {intl.formatMessage({
                    id: "settings.plugins.store.skills.scope.workspace",
                  })}
                </SelectItem>
                <SelectItem value="user">
                  {intl.formatMessage({
                    id: "settings.plugins.store.skills.scope.user",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            className="h-9"
            disabled={!draftQuery.trim()}
            data-testid="plugin-store-skills-submit"
          >
            <Search className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.store.skills.search" })}
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div
          role="tablist"
          aria-label={intl.formatMessage({
            id: "settings.plugins.store.segment.skills",
          })}
          className="flex flex-wrap items-center gap-1"
        >
          {CATALOG_TABS.map((catalogTab) => (
            <Button
              key={catalogTab}
              type="button"
              role="tab"
              size="sm"
              aria-selected={tab === catalogTab}
              variant={tab === catalogTab ? "secondary" : "ghost"}
              data-testid={`plugin-store-skills-tab-${catalogTab}`}
              onClick={() => setTab(catalogTab)}
            >
              {intl.formatMessage({
                id: catalogTab === "allTime" ? "catalog.tabs.allTime" : "catalog.tabs.popular",
              })}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <span id={sortLabelId} className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "catalog.sort.label" })}
          </span>
          <Select value={sortMode} onValueChange={(value) => setSortMode(value as CatalogSortMode)}>
            <SelectTrigger
              size="lg"
              aria-labelledby={sortLabelId}
              data-testid="plugin-store-skills-sort"
              className="h-9 rounded-xl"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="recommended">
                {intl.formatMessage({ id: "catalog.sort.recommended" })}
              </SelectItem>
              <SelectItem value="installs">
                {intl.formatMessage({ id: "catalog.sort.installs" })}
              </SelectItem>
              <SelectItem value="name">
                {intl.formatMessage({ id: "catalog.sort.name" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p data-testid="plugin-store-skills-source" className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "catalog.source.installs" })}
        {" · "}
        {intl.formatMessage({ id: "catalog.source.skillsSh" })}
      </p>
      {/* 搜索 API 没有 trending 字段/参数（实测），因此只说明数据来源，不伪造 Trending 页签。 */}
      <p
        data-testid="plugin-store-skills-no-trending"
        className="text-ui-xs text-foreground-subtle"
      >
        {intl.formatMessage({ id: "catalog.noTrendingData" })}
      </p>

      {marketplace.installError ? (
        <p
          role="alert"
          data-testid="plugin-store-skills-install-error"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          {intl.formatMessage(
            { id: "settings.plugins.store.skills.installFailed" },
            { name: marketplace.installError.name },
          )}
        </p>
      ) : null}

      {marketplace.installedNotice ? (
        <p
          role="status"
          data-testid="plugin-store-skills-installed-notice"
          className="rounded-lg bg-success-surface px-3 py-2 text-ui-base text-success-surface-foreground"
        >
          {intl.formatMessage(
            { id: "settings.plugins.store.skills.installedNotice" },
            { name: marketplace.installedNotice },
          )}
        </p>
      ) : null}

      {marketplace.error ? (
        <div
          role="alert"
          data-testid="plugin-store-skills-error"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <span>{intl.formatMessage({ id: "settings.plugins.store.skills.error" })}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="plugin-store-skills-retry"
            onClick={() => void marketplace.retry()}
          >
            {intl.formatMessage({ id: "settings.plugins.store.skills.retry" })}
          </Button>
        </div>
      ) : null}

      {marketplace.loading ? (
        <p
          role="status"
          data-testid="plugin-store-skills-loading"
          className="flex items-center gap-2 py-4 text-ui-base text-foreground-subtle"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.plugins.store.skills.loading" })}
        </p>
      ) : null}

      {showInstalled ? (
        <section className="space-y-2" aria-labelledby="plugin-store-skills-installed-title">
          <h3
            id="plugin-store-skills-installed-title"
            className="text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({
              id: "settings.plugins.store.skills.installedTitle",
            })}
          </h3>
          {marketplace.installedLoading ? (
            <p
              role="status"
              data-testid="plugin-store-skills-installed-loading"
              className="flex items-center gap-2 py-2 text-ui-base text-foreground-subtle"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({
                id: "settings.plugins.store.skills.installedLoading",
              })}
            </p>
          ) : null}
          {marketplace.installedError ? (
            <div
              role="alert"
              data-testid="plugin-store-skills-installed-error"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
            >
              <span>
                {intl.formatMessage({
                  id: "settings.plugins.store.skills.installedError",
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="plugin-store-skills-installed-retry"
                onClick={() => void marketplace.refreshInstalled()}
              >
                {intl.formatMessage({
                  id: "settings.plugins.store.skills.retry",
                })}
              </Button>
            </div>
          ) : null}
          {!marketplace.installedLoading &&
          !marketplace.installedError &&
          marketplace.installedSkills.length === 0 ? (
            <p
              data-testid="plugin-store-skills-installed-empty"
              className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "settings.plugins.store.skills.installedEmpty",
              })}
            </p>
          ) : null}
          {!marketplace.installedError && marketplace.installedSkills.length > 0 ? (
            <ul className="space-y-2" data-testid="plugin-store-skills-installed-list">
              {marketplace.installedSkills.map((skill) => (
                <InstalledSkillRow key={skill.id} skill={skill} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {showInstalled ? (
        <section className="space-y-2" data-testid="plugin-store-skills-catalog">
          {marketplace.catalogLoading ? (
            <p
              role="status"
              data-testid="plugin-store-skills-catalog-loading"
              className="flex items-center gap-2 py-2 text-ui-base text-foreground-subtle"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({
                id: "settings.plugins.store.skills.loading",
              })}
            </p>
          ) : null}
          {marketplace.catalogError ? (
            <div
              role="alert"
              data-testid="plugin-store-skills-catalog-error"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
            >
              <span>
                {intl.formatMessage({
                  id: "settings.plugins.store.skills.error",
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="plugin-store-skills-catalog-retry"
                onClick={() => void marketplace.refreshCatalog()}
              >
                {intl.formatMessage({
                  id: "settings.plugins.store.skills.retry",
                })}
              </Button>
            </div>
          ) : null}
          {!marketplace.catalogLoading && !marketplace.catalogError && catalogView.length === 0 ? (
            <p
              data-testid="plugin-store-skills-catalog-empty"
              className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "settings.plugins.store.skills.empty",
              })}
            </p>
          ) : null}
          {catalogView.length > 0 ? (
            <ul className="space-y-2" data-testid="plugin-store-skills-catalog-list">
              {catalogView.map(({ item, rank, badges }) => {
                const key = marketplaceSkillKey(item);
                return (
                  <SkillMarketplaceRow
                    key={key}
                    item={item}
                    rank={rank}
                    badges={badges}
                    installing={marketplace.installingKey === key}
                    installDisabled={installing}
                    onInstall={() => void marketplace.install(item, scope)}
                  />
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}

      {!marketplace.loading &&
      !marketplace.error &&
      !showInstalled &&
      marketplace.hasSearched &&
      searchView.length === 0 ? (
        <p
          data-testid="plugin-store-skills-empty"
          className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.plugins.store.skills.empty" })}
        </p>
      ) : null}

      {!showInstalled && searchView.length > 0 && !marketplace.error ? (
        <ul className="space-y-2" data-testid="plugin-store-skills-results">
          {searchView.map(({ item, rank, badges }) => {
            const key = marketplaceSkillKey(item);
            return (
              <SkillMarketplaceRow
                key={key}
                item={item}
                rank={rank}
                badges={badges}
                installing={marketplace.installingKey === key}
                installDisabled={installing}
                onInstall={() => void marketplace.install(item, scope)}
              />
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function InstalledSkillRow({ skill }: { skill: SkillSummary }) {
  const { intl } = useZCodeIntl();
  const scopeLabel =
    skill.scope === "workspace"
      ? intl.formatMessage({
          id: "settings.plugins.store.skills.scope.workspace",
        })
      : skill.scope === "user"
        ? intl.formatMessage({ id: "settings.plugins.store.skills.scope.user" })
        : skill.pluginName?.trim() || intl.formatMessage({ id: "settings.skills.scope.plugin" });
  const statusLabel = intl.formatMessage({
    id: skill.enabled
      ? "settings.plugins.store.skills.enabled"
      : "settings.plugins.store.skills.disabled",
  });
  return (
    <li
      data-testid={`plugin-store-skills-installed-item-${skill.id}`}
      data-enabled={skill.enabled ? "true" : "false"}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {skill.name}
          </span>
          <Badge variant={skill.enabled ? "default" : "outline"}>{statusLabel}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
          <span>{scopeLabel}</span>
          <span className="break-all font-mono">{skill.path}</span>
        </div>
      </div>
    </li>
  );
}

function SkillMarketplaceRow({
  item,
  rank,
  badges,
  installing,
  installDisabled,
  onInstall,
}: {
  item: MarketplaceSkillInfo;
  rank?: number;
  badges?: CatalogBadge[];
  installing: boolean;
  installDisabled: boolean;
  onInstall: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <li
      data-testid={`plugin-store-skills-item-${item.name}`}
      data-installed={item.installed ? "true" : "false"}
      data-rank={rank}
      aria-busy={installing}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {rank ? (
          <span
            data-testid={`plugin-store-skills-rank-${item.name}`}
            aria-label={intl.formatMessage({ id: "catalog.rankLabel" }, { rank })}
            className="shrink-0 pt-0.5 font-mono text-ui-xs text-foreground-subtle tabular-nums"
          >
            #{rank}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
              {item.name}
            </span>
            {badges?.map((badge) => (
              <Badge key={badge} variant={badge === "official" ? "secondary" : "outline"}>
                {intl.formatMessage({ id: `catalog.badge.${badge}` })}
              </Badge>
            ))}
            {item.installed ? (
              <Badge variant="outline">
                {intl.formatMessage({
                  id: "settings.plugins.store.skills.installed",
                })}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
            <span className="break-all font-mono">{item.source}</span>
            {typeof item.installs === "number" && Number.isFinite(item.installs) && item.installs >= 0 ? (
              <span>
                {intl.formatMessage(
                  { id: "settings.plugins.store.skills.installs" },
                  { count: item.installs },
                )}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <Button
        type="button"
        variant={item.installed ? "ghost" : "outline"}
        size="sm"
        data-testid={`plugin-store-skills-install-${item.name}`}
        disabled={item.installed || installDisabled}
        onClick={onInstall}
      >
        {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        {item.installed
          ? intl.formatMessage({
              id: "settings.plugins.store.skills.installed",
            })
          : installing
            ? intl.formatMessage({
                id: "settings.plugins.store.skills.installing",
              })
            : intl.formatMessage({
                id: "settings.plugins.store.skills.install",
              })}
      </Button>
    </li>
  );
}
