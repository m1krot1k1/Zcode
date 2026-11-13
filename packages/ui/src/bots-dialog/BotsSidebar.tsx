import { Plus } from "lucide-react";
import type { BotConfig, BotServiceStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBotDisplayName, ProviderIcon, runtimeDot } from "@/BotsDialog/shared.js";
import { BotChannelName } from "./BotChannelName.js";

/** BotsDialog 左侧 Bot 列表：新建入口、空状态和运行状态点。 */
export function BotsSidebar({
  bots,
  botRuntime,
  selectedBotId,
  creatingBot,
  fallbackBotName,
  onBeginAddBot,
  onSelectBot,
}: {
  bots: BotConfig[];
  botRuntime: BotServiceStatus["botRuntime"] | undefined;
  selectedBotId: string | null;
  creatingBot: boolean;
  fallbackBotName: string;
  onBeginAddBot: () => void;
  onSelectBot: (botId: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <aside className="flex max-h-40 w-full shrink-0 flex-col md:max-h-none md:w-64">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onBeginAddBot}
          className="mb-3 w-full justify-start gap-2 rounded-xl"
        >
          <Plus className="size-4" />
          <span className="min-w-0 truncate">{intl.formatMessage({ id: "bots.addBot" })}</span>
        </Button>
        {bots.length === 0 ? (
          <div className="p-4 text-ui-base text-foreground-subtle">
            {creatingBot
              ? intl.formatMessage({
                  id: "bots.newBot.selectProviderHint",
                })
              : intl.formatMessage({ id: "bots.empty" })}
          </div>
        ) : (
          bots.map((bot) => {
            const runtime = botRuntime?.find((item) => item.botId === bot.id);
            const selected = bot.id === selectedBotId;
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => onSelectBot(bot.id)}
                className={cn(
                  "mb-1 w-full rounded-xl px-2.5 pr-4 py-3 text-left transition-colors",
                  selected
                    ? "bg-surface-hover text-foreground"
                    : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <div className="flex items-center gap-2">
                  <ProviderIcon
                    provider={bot.provider}
                    className="size-10 shrink-0 object-contain text-foreground-subtle"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-foreground truncate text-ui-base font-medium">
                      {formatBotDisplayName(bot.name, fallbackBotName)}
                    </span>
                    <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                      <BotChannelName provider={bot.provider} />
                    </span>
                  </span>
                  <span
                    className={cn("size-2 shrink-0 rounded-full", runtimeDot(runtime, bot.enabled))}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
