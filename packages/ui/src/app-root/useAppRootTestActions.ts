import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { toLegacyBilingualLocale } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { taskListE2EActions } from "@/lib/taskListE2EActions.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTestActions } from "@/test-actions.js";
import type { TestActions } from "@/test-actions.js";

/**
 * Тестовый канал E2E: снимок темы/локали, подмена сообщений чата и доступ
 * к сервисам задач и плагинов. Регистрируется как app-level test actions.
 */
export function useAppRootTestActions({
  services,
  testMessages,
  setTestMessages,
}: {
  services: IServiceAccessor;
  testMessages: TestChatMessage[] | null;
  setTestMessages: Dispatch<SetStateAction<TestChatMessage[] | null>>;
}) {
  const { locale, setLocale } = useZCodeIntl();
  const theme = useZCodeStore((s) => s.theme);
  const setTheme = useZCodeStore((s) => s.setTheme);
  const testActions = useMemo<TestActions>(
    () => ({
      ...taskListE2EActions,
      sendBotMessage: (message) => services.botsService.handleInboundMessage(message),
      submitBotGroupInput: (params) => {
        const submit = services.zcodeTaskService.submitBotGroupInput;
        if (!submit) throw new Error("Task material admission unavailable");
        return submit.call(services.zcodeTaskService, params);
      },
      getTheme: () => theme,
      setTheme,
      getLocale: () => toLegacyBilingualLocale(locale),
      setLocale,
      setChatMessages: (messages) => {
        setTestMessages([...messages]);
      },
      getChatMessageCount: () => testMessages?.length ?? 0,
      getPluginsOverview: (params) => services.zcodeAgentService.getPluginsOverview(params),
      addPluginMarketplace: (params) => services.zcodeAgentService.addPluginMarketplace(params),
      updatePluginMarketplace: (params) =>
        services.zcodeAgentService.updatePluginMarketplace(params),
      installPlugin: (params) => services.zcodeAgentService.installPlugin(params),
      listPlugins: (params) => services.zcodeAgentService.listPlugins(params),
      getPluginReferenceCatalog: (params) =>
        services.zcodeAgentService.getPluginReferenceCatalog(params),
    }),
    [
      locale,
      services.botsService,
      services.zcodeTaskService,
      services.zcodeAgentService,
      setLocale,
      setTheme,
      theme,
      testMessages,
    ],
  );
  useTestActions(testActions);
}
