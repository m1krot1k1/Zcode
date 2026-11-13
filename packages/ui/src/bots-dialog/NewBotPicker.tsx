import { Loader2 } from "lucide-react";
import type { BotProvider } from "@zcode/shared";
import { BOT_PROVIDERS } from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { BotChannelName } from "./BotChannelName.js";

/** 新建 Bot 的渠道选择网格，未实现的渠道保持禁用但可见。 */
export function NewBotPicker({
  creatingProvider,
  onAddBot,
}: {
  creatingProvider: BotProvider | null;
  onAddBot: (provider: BotProvider) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-start gap-6">
      <div className="space-y-2">
        <div className="text-ui-lg font-medium">
          {intl.formatMessage({ id: "bots.newBot.title" })}
        </div>
        <p className="max-w-2xl text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "bots.newBot.description" })}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {BOT_PROVIDERS.filter((provider) => provider.id !== "webhook").map((provider) => {
          const implemented = provider.implemented;
          const isCreatingThisProvider = creatingProvider === provider.id;
          const isCreatingAnyProvider = creatingProvider !== null;
          return (
            <button
              key={provider.id}
              type="button"
              disabled={!implemented || isCreatingAnyProvider}
              aria-busy={isCreatingThisProvider}
              onClick={() => (implemented ? onAddBot(provider.id) : undefined)}
              className={cn(
                "flex items-start gap-3 rounded-lg border border-card-border bg-card py-4 px-3 text-left transition-colors",
                implemented && !isCreatingAnyProvider
                  ? "hover:border-input-border-focused hover:bg-surface-hover"
                  : "cursor-not-allowed opacity-60",
                isCreatingThisProvider &&
                  "border-input-border-focused bg-surface-hover opacity-100",
              )}
            >
              {isCreatingThisProvider ? (
                <div className="flex size-10 items-center justify-center">
                  <Loader2 className="size-6 shrink-0 animate-spin text-foreground-subtle" />
                </div>
              ) : (
                <ProviderIcon provider={provider.id} className="size-10 shrink-0 text-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 text-ui-lg font-medium">
                  <BotChannelName provider={provider.id} />
                </span>
                <span className="mt-1 block text-ui-base text-foreground-subtle">
                  {implemented
                    ? intl.formatMessage({
                        id: `bots.newBot.providerDescription.${provider.id}`,
                      })
                    : intl.formatMessage({
                        id: "bots.newBot.comingSoon",
                      })}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
