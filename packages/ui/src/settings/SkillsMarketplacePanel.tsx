import { Loader2, Search } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { MarketplaceSkillInfo } from "@zcode/shared";
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
  const marketplace = useSkillsMarketplace({ workspacePath, workspaceIdentity });
  const [draftQuery, setDraftQuery] = useState("");
  const [scope, setScope] = useState<SkillInstallScope>("workspace");
  const scopeLabelId = useId();
  const scopeLabel = intl.formatMessage({ id: "settings.plugins.store.skills.scopeLabel" });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void marketplace.search(draftQuery);
  };

  const installing = marketplace.installingKey !== null;
  const showIdle = !marketplace.hasSearched && !marketplace.loading && !marketplace.error;

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
        aria-label={intl.formatMessage({ id: "settings.plugins.store.skills.searchPlaceholder" })}
      >
        <SettingsSearchInput
          data-testid="plugin-store-skills-search"
          containerClassName="min-w-0 flex-[1_1_16rem]"
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          onClear={() => setDraftQuery("")}
          clearLabel={intl.formatMessage({ id: "settings.plugins.store.skills.clearSearch" })}
          placeholder={intl.formatMessage({
            id: "settings.plugins.store.skills.searchPlaceholder",
          })}
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span id={scopeLabelId} className="text-ui-xs text-foreground-subtle">
              {scopeLabel}
            </span>
            <Select
              value={scope}
              onValueChange={(value) => setScope(value as SkillInstallScope)}
            >
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
                  {intl.formatMessage({ id: "settings.plugins.store.skills.scope.workspace" })}
                </SelectItem>
                <SelectItem value="user">
                  {intl.formatMessage({ id: "settings.plugins.store.skills.scope.user" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            className="h-9"
            disabled={marketplace.loading || !draftQuery.trim()}
            data-testid="plugin-store-skills-submit"
          >
            <Search className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.store.skills.search" })}
          </Button>
        </div>
      </form>

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
          <span>
            {intl.formatMessage({ id: "settings.plugins.store.skills.error" })}
          </span>
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

      {!marketplace.loading && !marketplace.error && showIdle ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.store.skills.idle" })}
        </p>
      ) : null}

      {!marketplace.loading &&
      !marketplace.error &&
      marketplace.hasSearched &&
      marketplace.items.length === 0 ? (
        <p
          data-testid="plugin-store-skills-empty"
          className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.plugins.store.skills.empty" })}
        </p>
      ) : null}

      {marketplace.items.length > 0 && !marketplace.error ? (
        <ul className="space-y-2" data-testid="plugin-store-skills-results">
          {marketplace.items.map((item) => {
            const key = marketplaceSkillKey(item);
            return (
              <SkillMarketplaceRow
                key={key}
                item={item}
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

function SkillMarketplaceRow({
  item,
  installing,
  installDisabled,
  onInstall,
}: {
  item: MarketplaceSkillInfo;
  installing: boolean;
  installDisabled: boolean;
  onInstall: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <li
      data-testid={`plugin-store-skills-item-${item.name}`}
      data-installed={item.installed ? "true" : "false"}
      aria-busy={installing}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {item.name}
          </span>
          {item.installed ? (
            <Badge variant="outline">
              {intl.formatMessage({ id: "settings.plugins.store.skills.installed" })}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
          <span className="break-all font-mono">{item.source}</span>
          <span>
            {intl.formatMessage(
              { id: "settings.plugins.store.skills.installs" },
              { count: item.installs },
            )}
          </span>
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
          ? intl.formatMessage({ id: "settings.plugins.store.skills.installed" })
          : installing
            ? intl.formatMessage({ id: "settings.plugins.store.skills.installing" })
            : intl.formatMessage({ id: "settings.plugins.store.skills.install" })}
      </Button>
    </li>
  );
}
