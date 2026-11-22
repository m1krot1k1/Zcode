# Z15 — Monetization, onboarding, marketplace и продуктовые telemetry/growth-поверхности

> Research-only артефакт. Продуктовый код, конфиги, зависимости и lockfile не изменялись.
> Дата исследования: 2026-11-11. Ветка `dev`, HEAD `d10f0b69` («Выпустить macOS Preview 3.17.102»).
> Единственная запись этого филиала — данный файл. Метки: **[Observed]** — проверено по исходнику/команде; **[Inference]** — вывод из evidence; **[Unknown]** — источники не подтверждают.

## 1. Scope and method

### 1.1. Skill и границы

- Skill `research` загружен по точному имени через `Skill`. Применена его дисциплина: primary sources (код, тесты, docs), разделение FACT / HYPOTHESIS / UNKNOWN, фиксация непроверенного.
- Роль: researcher, read-only, кроме этого partial-файла. `pnpm typecheck`, `pnpm lint`, полный unit-набор, desktop E2E, тяжёлые сборки и живые сетевые вызовы не запускались.
- CodeIndex: `status` → `state: ready`, `partial: false`, generation `1456`, 10007 files, 26791 chunks, 278154 symbols, 377669 edges. Адресные `search` использовались как указатели; все load-bearing факты ниже подтверждены чтением исходника, а не только индексом.
- Границы темы (конверт Z15): тема 23 — монетизация/продуктовые механики/onboarding/marketplace + product telemetry и growth-поверхности.

### 1.2. Preflight (Observed)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

`docs/research/` — untracked каталог исследования; продуктовых изменений не было. Ветка не переключалась.

### 1.3. Как читалась область

- Домен-словарь: `CONTEXT.md` (89 строк) прочитан полностью; затем каждое определение сверялось с `packages/ui/src/settings/*`, `apps/zcode-cli/packages/{contracts,adapters,bootstrap}/src/plugins/*`, `packages/shared/src/*`.
- Монетизация/entitlements/quota: `packages/shared/src/coding-plan-subscription.ts`, `packages/shared/src/usage-stats.ts`, `packages/ui/src/hooks/useUsageEntitlement.ts`, `packages/ui/src/lib/usageEntitlementCache.ts`, `packages/ui/src/settings/model-provider-section/*`, `packages/ui/src/v4/sessionQuotaBannerState.ts`, `packages/services/src/coding-plan-subscription/*`, docs `coding-plan-*.md`.
- Auth/accounts: `packages/shared/src/oauth.ts`, `packages/services/src/oauth/*`, `packages/ui/src/WelcomeScreen.tsx`, `packages/ui/src/login/LoginApiKeyForm.tsx`, `packages/ui/src/WorkspaceSidebarFooter.tsx`.
- Onboarding: `packages/ui/src/onboarding/*`, `packages/services/src/onboarding/*`, docs `onboarding-record-spec.md`, `monitoring/onboarding-telemetry.md`, `onboarding-external-agent-import-steps.md`.
- Marketplace: `apps/zcode-cli/packages/contracts/src/plugins/index.ts`, `apps/zcode-cli/packages/adapters/src/plugins/*`, `apps/zcode-cli/packages/bootstrap/src/plugins.ts`, `packages/services/src/plugins/*`, `packages/ui/src/settings/Plugin*.tsx|ts`, docs `plugin-marketplace-ui-ux.md`, `plugins/plugin-market-interactions-scope.md`, `plugin-management-lifecycle-case-catalog.md`, `monitoring/plugin-lifecycle-telemetry.md`.
- Telemetry/consent/experiments: `packages/shared/src/telemetry.ts`, `packages/services/src/telemetry/telemetryCore.ts`, `packages/desktop/src/main/appTelemetryRuntime.ts`, `packages/shared/src/clientConfig.ts`, `dynamic-workflow-feature.ts`, docs `monitoring/*`.
- Updates/distribution: `packages/desktop/src/main/{autoUpdater,manifestUpdateProvider,forceUpdateGuard,desktopCommandHandlers,desktopApplicationMenu}.ts`, `packages/ui/src/{UpdateStatusButton,UpdateStatusDialog,updateReleaseNotes}.ts(x)`, `packages/shared/src/{forceUpdate,desktopMenu}.ts`, docs `settings-preview-updates-copy.md`, `force-update-client-config.md`.
- i18n: сравнение ключей `en-US.ts` / `zh-CN.ts` / `ru-RU.json` ad-hoc Node-скриптом (чтение файлов, без записи).

### 1.4. Ограничения метода

- Все выводы — code-level. Реальный рендер, нажатия, сетевые ответы, CDN, платёжный webview и мобильный relay не проверялись.
- Отсутствие функциональности доказывается негативным результатом адресного grep по конкретным терминам. Это **не** математическое доказательство отсутствия: индекс/поиск могут пропускать генерируемые или обфусцированные пути. Такие пункты помечены как «Absent (по коду)» с указанием терминов.
- Часть docs описывает исторические состояния; расхождения docs↔код фиксируются отдельно.

## 2. Coverage table

| # | Область (пункт конверта Z15) | Статус | Основные источники |
| --- | --- | --- | --- |
| 2.1 | `CONTEXT.md`: домен-словарь plugin store + сверка с реализацией | полный (8 терминов + 3 расхождения) | §3.1; `CONTEXT.md:1-89`, `contracts/src/plugins/index.ts:7,115-166`, `pluginStoreListing.ts:156-190,343-390` |
| 2.2 | Монетизация: планы/тиры/entitlements/quota/биллинг/paywall/trial/gating/license/seats/team | полный (код) | §3.2; `coding-plan-subscription.ts:7-15,118-185,429-590`, `usage-stats.ts:78-135`, `sessionQuotaBannerState.ts:20-52,306-308` |
| 2.3 | Auth/accounts: провайдеры, org/workspace, профиль, переключение, privacy, export/delete | полный (код) | §3.3; `oauth.ts:9-67`, `providers/*Config.ts`, `WelcomeScreen.tsx:320-368`, `WorkspaceSidebarFooter.tsx:143-310,455-470` |
| 2.4 | Onboarding: first-run, проект, provider setup, auth wizard, sample tasks, empty states, tips, shortcuts, импорт | полный (код) / частичный (проект и provider setup) | §3.4; `OccupationOnboarding.tsx:65-233`, `useOnboardingTrigger.ts:22-134`, `onboardingRecordService.ts:29-240`, `OnboardingDialog.tsx:38-108` |
| 2.5 | Marketplace: каталог, install/update/uninstall, ratings, verification, publisher, moderation, search, categories, compatibility, version resolution, revenue share | полный (код) | §3.5; `marketplace.ts:76,120,410,716,815,1303,2270-2324`, `zcode-protocol/index.ts:4698-4709`, `PluginStorePage.tsx:126-514` |
| 2.6 | Product telemetry: activation/retention, funnel, experiment flags/A-B, consent, opt-out | полный для событий / отсутствие consent и A-B подтверждено негативным grep | §3.6; `telemetryCore.ts:587-680`, `pluginManagementService.ts:96-207`, `useOnboardingTelemetry.ts:55-124` |
| 2.7 | Update/distribution: preview vs stable, version messaging, changelog, feedback | полный (код) | §3.7; `autoUpdater.ts:777-790`, `manifestUpdateProvider.ts:36-41`, `desktopCommandHandlers.ts:452-467,586-618` |
| 2.8 | UX-поверхности: settings pages, billing UI, marketplace UI, onboarding UI, i18n | полный (code-level) | §3.8; `settingsPageConfig.ts:60-190`, `settingsNavigation.ts:4-25`, i18n-скрипт (7501/7503/7503 ключей) |
| 2.9 | Тесты: entitlement/billing/marketplace/onboarding | полный (инвентаризация файлов), исполнение не выполнялось | §3.9; списки `packages/ui/test`, `packages/services/test`, `apps/zcode-cli/**/tests`, `packages/desktop/test/e2e/plugins` |
| 2.10 | Gaps/risks: отсутствие монетизации, неполный onboarding, trust в marketplace, telemetry privacy, upgrade paths | полный (синтез) | §4, §6, §7 |

## 3. Capability inventory

### 3.1. `CONTEXT.md` — домен-словарь и сверка с реализацией (Observed)

**Что зафиксировано в словаре.** `CONTEXT.md` объявляет себя единственным источником истины для терминов plugin store, введённых редизайном 2026-07 (`CONTEXT.md:1-3`). Термины и их определения:

| Термин | Определение в `CONTEXT.md` | Совпадение с кодом |
| --- | --- | --- |
| Official Marketplace | единственный официальный канал, id `zcode-plugins-official`; builtin + CDN (`CONTEXT.md:9-11`) | Совпадает: `contracts/src/plugins/index.ts:7` |
| Builtin Plugin | поставляется в бандле и «сидируется» в официальный маркет (`CONTEXT.md:13-15`) | Совпадает: `bootstrap/src/plugins.ts:660-668`, `official-marketplace.ts:81-130` |
| CDN Plugin | zip по официальному CDN с проверкой sha256 (`CONTEXT.md:17-19`) | Совпадает: `marketplace.ts:76,2632-2634` |
| Personal Source | все пользовательские источники, включая `claude-plugins-official`, git/GitHub/URL/local, inline (`CONTEXT.md:21-23`) | Совпадает: `PluginStorePage.tsx:170-190`, `pluginStoreListing.ts:179-182` |
| Catalog Auto-Refresh | троттлинг 10 минут, только official (`CONTEXT.md:25-27`) | Совпадает: `officialMarketplaceAutoRefresh.ts:15,25-32`; `PluginStorePage.tsx:170-190` |
| Manual Refresh | полный refresh всех маркетов (`CONTEXT.md:29-31`) | Совпадает: `PluginStorePage.tsx:368-377,433` |
| Public Segment | `publisherType: official`, отсутствие поля = public (`CONTEXT.md:35-37`) | Совпадает: `pluginStoreListing.ts:179-182` |
| Community Segment | `publisherType: community`, из `external_plugins/` (`CONTEXT.md:39-40`) | Частично: клиент читает поле (`marketplace.ts:2323-2324`); каталог `external_plugins/` в этом репозитории отсутствует (`ls external_plugins` → exit 1) |
| Personal Segment | все не-official источники (`CONTEXT.md:42-44`) | Совпадает: `pluginStoreListing.ts:180` |
| Featured | top public, remote `featured[]` (`CONTEXT.md:46-48`) | Совпадает: `marketplace.ts:120,2270-2285`; `pluginStoreListing.ts:343-365` |
| Recommended | top personal, локальный `recommendedPlugins.json` (`CONTEXT.md:50-52`) | **Расхождение**: список удалён, json хранит только id (`recommendedPlugins.ts:3-9`, `recommendedPlugins.json`) |
| Manage Installed View | management внутри store, меню только pause/enable + uninstall (`CONTEXT.md:54-55`) | Совпадает: `PluginStorePage.tsx:640,657`; `PluginStoreCard.tsx:120-180` |
| UI Plugin | `ui.surfaces` + `componentTypes: ["ui"]` (`CONTEXT.md:57-58`) | Совпадает: `pluginStoreListing.ts:184-190` |
| Default UI Recommendations | `uiPluginRecommendations` в client config (`CONTEXT.md:60-61`) | Совпадает: `clientConfig.ts:5-8,11-16` |
| Store Listing | display-метаданные каталога (`CONTEXT.md:65-67`) | Совпадает: `contracts/src/plugins/index.ts:115-142` |
| Plugin Manifest | `plugin.json` функциональное определение (`CONTEXT.md:69-71`) | Совпадает: `contracts/src/plugins/index.ts:144-166` |
| Example Prompt | кликабельный prompt, единственный вход «новый session»; «Try now» удалён 2026-07-14 (`CONTEXT.md:73-75`) | **Расхождение**: в коде есть `plugin-store-try-now` (`PluginStoreDetailView.tsx:160-171`), и UI-spec сохраняет Try now (`docs/plugin-marketplace-ui-ux.md:232-237`) |
| Plugin Lifecycle | полный путь discovery→install→…→uninstall/restore (`CONTEXT.md:79-81`) | Совпадает: `docs/monitoring/plugin-lifecycle-telemetry.md:5-11`; `pluginManagementService.ts:96-207` |
| Restorable Builtin | подавленный builtin, восстановление из Public (`CONTEXT.md:83-85`) | Совпадает: `bootstrap/src/plugins.ts:263,341-347,660-668,905-929` |
| Orphaned Installed Plugin | источник удалён, установка/данные сохранены, update недоступен (`CONTEXT.md:87-89`) | Совпадает: `pluginStoreListing.ts:280-332`; `PluginStoreCard.tsx:232-333` |

**Три подтверждённых расхождения словаря с текущим кодом/спеками:**

1. **Recommended.** `CONTEXT.md:50-52` утверждает, что список поддерживается в `recommendedPlugins.json`. Фактически `packages/ui/src/settings/recommendedPlugins.ts:3-6` прямо пишет, что рекомендованный блок снят, а из json остался только `marketplace`; `docs/plugin-marketplace-ui-ux.md:212` подтверждает снятие. **[Observed]**
2. **Example Prompt / Try now.** `CONTEXT.md:73-75` называет Example Prompt единственным входом в новый session и утверждает, что «立即试用» удалён 2026-07-14. Код рендерит кнопку Try now (`PluginStoreDetailView.tsx:160-171`), а `<docs/plugin-marketplace-ui-ux.md:232-237,454-455>` описывает её как действующую. **[Observed]** — противоречие документов; какой источник считать актуальным, из кода однозначно не следует (см. §7).
3. **Сегменты store.** `CONTEXT.md` знает Public/Community/Personal (`CONTEXT.md:33-44`), но UI содержит пять pills: public, community, personal, skills, catalog (`PluginStoreListView.tsx:37,167-196`). Сегменты `skills`/`catalog` не описаны в `CONTEXT.md` и не описаны в `docs/plugin-marketplace-ui-ux.md` (поиск «catalog» даёт только Catalog Auto-Refresh, `docs/plugin-marketplace-ui-ux.md:137`). **[Observed]**

### 3.2. Монетизация: планы, entitlements, quota, биллинг, gating (Observed)

**Планы и тиры.** Модель данных знает два семейства (Z.ai, BigModel) и три класса плана: Start Plan (бесплатный/пробный), Individual Coding Plan, Team Coding Plan (`packages/shared/src/model-provider-family.ts:9-36`; `packages/shared/src/coding-plan-subscription.ts:9-15`). Enterprise-тиры — `LITE | PRO | MAX`, режимы `CONTINUOUS | ONE_TIME`, периоды `MONTHLY | QUARTERLY | YEARLY` (`coding-plan-subscription.ts:429-439`). Платёжные каналы: `ALI | WECHAT` и `STRIPE_PAY | PAYPAL_PAY` (`coding-plan-subscription.ts:7-8`).

**Entitlements.** Канонический снимок прав: `UsageEntitlementSnapshot` с `authenticated`, `unavailableReason` (`not_authenticated | not_configured | no_plan | unavailable`), `startPlanExpired`, `teamPlanUnavailableReason` (`expired | unassigned`), `context` (personal/team + org/project), `provider`, `remaining`, `subscription`, `quota`, `mcpQuota` (`packages/shared/src/usage-stats.ts:78-101`). Плоский статус плана: `PlanIdentityStatus = coding_plan | start_plan | no_plan | unknown` (`usage-stats.ts:111-117`). UI-хук `useUsageEntitlement` кэширует снимок в `localStorage` на 10 минут и дедуплицирует in-flight запросы (`usageEntitlementCache.ts:4-5,20-31`; `useUsageEntitlement.ts:50-90`).

**Quota и её enforcement.** Quota-состояние сессии моделируется как `SessionQuotaBannerKind` с семью видами (`model-very-low`, `model-exhausted`, `daily-exhausted`, `concurrent-limit`, `provider-limited`, `mcp-quota-exhausted`, `mcp-plan-required`) и флагом `blocksSubmit` (`packages/ui/src/v4/sessionQuotaBannerState.ts:20-52`). Composer реально блокируется: `disabled={... || quotaBanner.state.blocksSubmit}` (`packages/ui/src/v4/SessionPane.tsx:5555-5571`). Апгрейд предлагается для всех видов, кроме `mcp-quota-exhausted` (`sessionQuotaBannerState.ts:306-308`).

**Биллинг-интеграция.** Нативный purchase panel удалён: «`CodingPlanPricingCards` … вместе с `CodingPlanPurchasePanel` … 购买流程切换为内嵌官网 webview» (`packages/ui/src/settings/model-provider-section/codingPlanPricingCards.ts:4-6`; `codingPlanEnterpriseTiers.ts:4`). Покупка/апгрейд идёт через embedded webview официального сайта `/coding-plan` с инъекцией токенов и bridge-сообщением о завершении (`docs/coding-plan-webview-bridge.md:1-20`; `codingPlanEmbeddedWebview.ts:113-126`; `CodingPlanUpgradeDialog.tsx:66-150`). Enterprise order API (pricing/balance/calculate/create/cancel/continue/status) есть в сервисе (`packages/services/src/coding-plan-subscription/codingPlanSubscription.ts:100-130`; `bigmodelCodingPlanSubscriptionProvider.ts:634-699`), но UI-вызовов `calculateEnterpriseOrder` / `createEnterpriseOrder` / `cancelEnterpriseOrder` не найдено — только `getEnterprisePricing` (`packages/ui/src/settings/CodingPlanUpgradeDialog.tsx:106`; `useEnterpriseCodingPlanProducts.ts:182`). **[Observed]**

**Paywall / feature gating.** Отдельного paywall-экрана нет. Gating распределён:
- quota-баннер блокирует submit (`SessionPane.tsx:5567-5571`);
- провайдер отключается системно по `systemDisabledReason` (`docs/model-provider-coding-plan-availability.md:21-27`);
- off-peak вход гейтится remote-флагом `enable_offpeak_task` + наличием моделей (`bigmodelCodingPlanSubscriptionProvider.ts:169,1562`);
- dynamic workflow гейтится remote-модом `disabled | onDemand | alwaysOn` (`packages/shared/src/dynamic-workflow-feature.ts:9-23`);
- CUA гейтится env-фича-флагом (`packages/shared/src/runtimeEnv.ts:40`; `packages/services/src/node.ts:777`);
- в marketplace `requiresPaidPlan` — **только display-бейдж**, не участие в установке/биллинге (`contracts/src/plugins/index.ts:137-141`; `PluginStoreCard.tsx:48-63`; `docs/plugin-marketplace-ui-ux.md:331-342`).

**Trial.** Бесплатный вход реализован как Start Plan: карточка строится из remote `startPlanPreview.entitlements` (`packages/ui/src/settings/model-provider-section/StartPlanCard.tsx:17-40`), а недоступность описывается через `startPlanExpired` (`usage-stats.ts:84-85`). Локального trial-таймера/активации в клиенте нет. Часть trial-строк i18n не используется: `settings.modelProvider.startPlan.highlight.trial.label` не встречается в `packages/ui/src` вне locale-файлов (ad-hoc Node-проверка → `UNUSED`). **[Observed]**

**License checks / seats / team-org.** Лицензионных ключей и активации не найдено: адресный grep `licenseKey|license_key|activationKey` по `packages apps` (без `node_modules/dist`) не дал продуктовых совпадений. Seat-модель есть в типах (`maxSeats` в `EnterpriseCodingPlanOrderCalculateRequest/CreateOrderRequest`, `coding-plan-subscription.ts:506-539`; `seatCount` в pending order, `:554-564`), но UI-степпера мест нет: grep `seatCount|setSeatCount|maxSeats` по `packages/ui/src/settings/**/*.tsx` пуст; i18n-ключи `...enterprise.seats`, `...seatInputUnit`, `...seatQuantity` — `UNUSED`. Команды/приглашения участников отсутствуют (grep `invite|members` даёт только несвязанные совпадения). Сам продукт-док фиксирует: «не реализуем … 企业成员席位管理» (`docs/coding-plan-enterprise.md:70-72`). Управление подпиской уводится на внешний URL `teamCodingPlanManageUrl` (`model-provider-family.ts:35,45`).

### 3.3. Auth/accounts, org, privacy (Observed)

- **Провайдеры входа.** Только два OAuth-провайдера: `BIGMODEL_PROVIDER_ID = "bigmodel"`, `ZAI_PROVIDER_ID = "zai"` (`packages/shared/src/oauth.ts:9-12`; тип `OAuthProviderId`, `:56-59`). Метаданные с `displayName`/`order`: `providers/zaiProviderConfig.ts:16-19`, `providers/bigmodelProviderConfig.ts:14-17`. Google/GitHub/Apple и т.п. отсутствуют.
- **Альтернативные входы.** API key + «Skip for now»: `WelcomeScreen.tsx:320-368`; `LoginApiKeyForm.tsx:45-48,131,280`; строка `login.skip` (`en-US.ts:1409`).
- **Профиль.** Sidebar footer показывает avatar/id, копирует user id, даёт Login/Logout (`WorkspaceSidebarFooter.tsx:143-166,280-310,455-470`). Редактирования профиля нет.
- **Переключение аккаунта.** В коде отсутствует: ключ `settings.modelProvider.codingPlan.switchAccount` существует только в locale-файлах (`en-US.ts:4330`, `zh-CN.ts:4047`), grep по `packages apps` без locales не даёт call-site. Активная учётка одна (`oauthCredentialRepo.loadActiveUserProfile()`).
- **Org/workspace membership.** Модели членства нет. Есть только биллинговый контекст team plan: `organizationId`, `projectId` в `zcodeAccountAccessSchema` (`packages/shared/src/zcode-protocol/index.ts:1208-1219`) и Enterprise pricing (`coding-plan-subscription.ts:441-472`). Workspace — это локальный/remote рабочий каталог, не организация.
- **Privacy controls.** Пользовательского тумблера телеметрии нет: в `appSettingsObjectSchema` поля `telemetry/*` отсутствуют (`packages/shared/src/validationAppSettings.ts:560-590`), grep `telemetry` по этому файлу пуст.
- **Data export/delete.** Аккаунт-скоупного export/delete нет: grep `delete.?account|account.?deletion|export.?my.?data|data.?export|gdpr` по `packages/{ui,services,desktop,shared}/src` пуст. Есть локальные операции: «Clear All Data» удаляет `~/.zcode/v2` + localStorage и перезапускает приложение (`packages/desktop/src/main/desktopCommandHandlers.ts:83-130`), «Export Logs» (`desktopCommandHandlers.ts:616-618`). Это не удаление серверного аккаунта и не выгрузка данных аккаунта.
- **Privacy-by-redaction.** Для feedback/telemetry есть редактирование чувствительных полей: `packages/shared/src/feedbackPrivacy.ts:1-90`; `docs/monitoring/event-report-privacy.md:8-36`; `packages/shared/src/telemetry.ts:216-241`.

### 3.4. Onboarding / first-run / empty states (Observed)

- **First-run wizard.** `OccupationOnboarding` — три шага (`step` 0..2) в `OccupationOnboarding.tsx:65`; сбор occupation/mode/preferences и запись в settings (`:197-233`). Показ: `requested || (needsOnboarding && !dismissed)`-логика с release budget (`OccupationOnboarding.tsx:89,216-217`).
- **Триггер.** `useOnboardingTrigger` вызывает `claimAnonymousRecord()` → `shouldOnboard(deviceMid)`, с 3-секундным бюджетом и fail-closed семантикой (таймаут/rejection/нет сервиса → не показывать) (`useOnboardingTrigger.ts:44,52,63,70-74,106-111`). Правила и обоснование — `docs/onboarding-record-spec.md:97-147`.
- **Персистентность.** `onboarding-record.json` в app config dir (`packages/services/src/onboarding/onboardingRecordService.ts:29`), методы `appendRecord/claimAnonymousRecord/shouldOnboard/dismissOnboarding/getLatestEntry/syncSettingsFromRecord/updateRecordPreferences/getRecords/clearRecords` (`onboardingRecordService.ts:74-240`; интерфейс `onboardingRecord.ts:19-50`). `uploadState: "pending"` зарезервирован, серверной выгрузки нет (`docs/onboarding-record-spec.md:296-305`).
- **Auth wizard.** WelcomeScreen как первый экран; OAuth/BigModel/Z.ai, API key, skip (`WelcomeScreen.tsx:320-368`).
- **Открытие проекта.** Есть `DirectoryBrowser` и `handleOpenDirectoryBrowser` (`packages/ui/src/Root.tsx:38,313,674-675`), но отдельного onboarding-шага «откройте проект» нет: шаги wizard — session/skills/mcp/commands/agents-file/migration (`OnboardingDialog.tsx:38-45`). **[Observed]** Отсутствие guided-шага — вывод из списка шагов, не из документа-спеки.
- **Model/provider setup.** Отдельного шага настройки провайдера в onboarding нет; настройка живёт в Settings → Model Providers (`settingsPageConfig.ts:72-77`). **[Observed]**
- **Sample tasks.** Пул рекомендованных промптов по режиму office/coding (`packages/ui/src/v4/featureSuggestedPrompts.ts:18,565-568`); показ на пустом драфте при `!isOfficeMode || proactiveSuggestionsEnabled === true` (`SessionPane.tsx:5767`).
- **Empty states.** Плагинные состояния: `PluginInstallEmptyState` / `PluginLoadingState` / `PluginSearchEmptyState` (`packages/ui/src/settings/PluginInstallEmptyState.tsx:1-36`); пустой community: `data-testid="plugin-store-community-empty"` (`PluginStoreListView.tsx:267-272`); пустой поиск — `settings.plugins.store.searchEmpty` (`PluginStoreListView.tsx:~253`).
- **Tips / tours.** Coachmark/tour/spotlight не найдено: grep `tour|walkthrough|coachmark|spotlight` по `packages/ui/src` даёт только tooltip/несвязанные совпадения (`EXIT:1` для содержательных). **[Observed absence]**
- **Shortcut discovery.** Есть раздел Settings → Keyboard Shortcuts (`settingsPageConfig.ts`, секция `shortcuts`; `packages/ui/src/settings/ShortcutSettingsSection.tsx:39`) и command palette с shortcut-подсказками (`packages/ui/src/quickpick/quickPickCommands.ts:42,77-140`); дефолты — `packages/shared/src/shortcutCommands.ts:102` (`openOnboarding` = `CmdOrCtrl+Shift+o`). Отдельного first-run обучения шорткатам нет.
- **Import from other tools.** В onboarding wizard включены шаги `skills-import`, `mcp-import`, `commands-import`, `agents-file`; `plugins-import` закомментирован (`OnboardingDialog.tsx:38-45,94`). Спека: `docs/onboarding-external-agent-import-steps.md:1-30`. First-run prompt импорта управляется флагом `settingsSyncFirstRunPromptHandled` (`validationAppSettings.ts:584`; `useSettingsSync.ts:254-306`).
- **Повторное открытие.** Settings → «引导» кнопка `settings.onboarding` (`SettingsPage.tsx:1761-1777`); shortcut `openOnboarding` (`shortcutCommands.ts:102`).

### 3.5. Marketplace/store (Observed)

- **Каталог и сегменты.** Store page задаёт `PluginStoreTab = public | community | personal | skills | catalog` (`PluginStoreListView.tsx:37`); pills — `:167-196`; catalog-сегмент рендерит `PluginCatalogView` (`:237-243`). Резолвинг сегмента по `publisherType` — `pluginStoreListing.ts:177-182`, UI-spec — `docs/plugin-marketplace-ui-ux.md:179-213`.
- **Featured и категории.** `featured` из официального манифеста (`marketplace.ts:120,2270-2285`) → `selectFeaturedItems` (`pluginStoreListing.ts:343-365`); группировка по `category` (`:367-390`), известные категории — `:156-166`.
- **Install/update/uninstall.** Протокол: `plugins/marketplace/add|remove|update`, `plugins/install|uninstall|update|restoreBuiltin|describe` (`packages/shared/src/zcode-protocol/index.ts:4698-4709`). Сервис + телеметрия: `packages/services/src/plugins/pluginManagementService.ts:180-207`. Адаптеры: `marketplace.ts:410` (add), `:716` (update), `:815` (install), `uninstallMarketplacePlugin` (в том же файле). UI: install/update/uninstall handlers — `PluginStorePage.tsx:407-514`.
- **Отмена установки.** Кнопка установки только disabled + spinner, без cancel-действия (`PluginStoreCard.tsx:187-226`, `disabled={installing}` `:209`). Это зафиксировано как bug candidate в `docs/plugin-marketplace-ui-ux.md:90-93`.
- **Ratings/reviews/installs.** Отсутствуют. Явный non-goal: «评分、下载量、README 渲染 — 无数据源» (`docs/plugin-marketplace-ui-ux.md:82`). Модель каталога документирует, что install counts/publish date не публикуются и UI их не рисует (`packages/ui/src/settings/pluginCatalogModel.ts:13-24,37-40`). Общий контракт каталогов запрещает фабриковать метрики (`docs/catalog-leaderboard.md:11-22`).
- **Publisher identity / verification / moderation.** Есть только `publisherType: official|community` и `author/authorUrl` (`contracts/src/plugins/index.ts:115-142`; парсинг `marketplace.ts:2323-2324`). Верификации издателя, подписей, provenance и in-app moderation не найдено (grep `verifiedPublisher|publisherVerification|signature|provenance|attestation|moderation` по `packages apps docs` без node_modules даёт ноль продуктовых совпадений). Модерация описана как внешний процесс репозитория публикации: `external_plugins/` + review/валидаторы (`docs/plugins/plugin-market-interactions-scope.md:21-56`); сам каталог `external_plugins/` в этом репозитории отсутствует (`ls external_plugins` → exit 1).
- **Search.** Полнотекст + пиньинь (полный/инициалы) — `packages/ui/src/settings/pluginSearch.ts:1-33`; матчинг полей — `pluginStoreListing.ts:409-424`; поиск ограничен текущим сегментом (`docs/plugin-marketplace-ui-ux.md:166-170`).
- **Compatibility metadata.** Отсутствует: в `PluginManifest` нет `engines/minAppVersion/zcodeVersion/apiVersion` (`contracts/src/plugins/index.ts:144-166`); grep по `engines|minAppVersion|compatib` в контракте и адаптере пуст. **[Observed absence]**
- **Version resolution.** Semver-сравнение с fallback на source identity pin (`apps/zcode-cli/packages/adapters/src/plugins/version-compare.ts:12-45`); dependency closure при install (`marketplace.ts:830,1303-1340`) и manifest-diagnostics (`:2700-2775`).
- **Источники.** Add source поддерживает github/git/URL/local (drag-n-drop) (`docs/plugin-marketplace-ui-ux.md:144-150`; `AddMarketplaceSourceDialog.tsx:13`); sources dialog умеет refresh/remove, но не validate (`PluginStoreSourcesDialog.tsx:49-57,132,151`; отсутствие validate — bug candidate, `<docs/plugin-marketplace-ui-ux.md:93>`).
- **Integrity/trust.** Zip требует 64-hex sha256 (`marketplace.ts:76,2632-2634`); защита от подмены id официального маркета (`marketplace.ts:416-453`); offline preview блокирует официальный CDN (`marketplace.ts:396-400,707-708`).
- **Доход/rev share.** Отсутствует: grep `revenueShare|revenue_share|publisherRevenue|paidPlugin|pluginPrice` по repo (без node_modules/dist/.git) — ноль совпадений. `requiresPaidPlan` — только badge.

### 3.6. Product telemetry (Observed)

- **Activation/retention.** `app_launch` и `app_daily_active` с дедупликацией по локальной дате и in-flight lock (`packages/services/src/telemetry/telemetryCore.ts:587-680`); runtime вызывает их при renderer ready / OAuth callback / heartbeat (`packages/desktop/src/main/appTelemetryRuntime.ts:40,53,72,106-114`). `session_create` — отдельная спека (`docs/monitoring/session-create-telemetry.md:1-40`).
- **Funnel instrumentation.**
  - Coding Plan: `coding_plan_upgrade_ck` + `purchase_funnel_id` (`packages/ui/src/lib/codingPlanFunnelTelemetry.ts:13-26,168-199`); спека `docs/coding-plan-purchase-funnel-telemetry.md:1-80`; контекст прокидывается в webview (`codingPlanEmbeddedWebview.ts:228-248`).
  - Plugin lifecycle: `plugin_lifecycle/plugin_discovery/plugin_usage/plugin_runtime_error`, whitelist-поля (`packages/shared/src/telemetry.ts:56-113`; `packages/services/src/plugins/pluginManagementService.ts:96-207`; `docs/monitoring/plugin-lifecycle-telemetry.md:5-43`). `plugin_discovery` для view и search — `PluginStorePage.tsx:222-243,785-799`.
  - Onboarding: `onboarding_expose` / `onboarding_end` с exit_action и снапшотом выбора (`packages/ui/src/onboarding/useOnboardingTelemetry.ts:55-124`; `docs/monitoring/onboarding-telemetry.md:1-60`).
- **Privacy/redaction.** Все события проходят `sanitizeTelemetryEventDetail` (`telemetry.ts:216-241`); `error_msg` → `[redacted]`, `login_url` → только hostname (`docs/monitoring/event-report-privacy.md:8-20`). Plugin-события — строгий whitelist (`telemetry.ts:15-113`).
- **Consent/opt-out.** Отсутствуют. Единственный «выключатель» — build-time endpoint: если `ZCODE_TELEMETRY_REPORT_ENDPOINT` пуст, `sendReport` no-op (`packages/shared/src/env.ts:60-64`; `telemetryCore.ts:419`). UI-тумблера нет; grep `ZCODE_DISABLE_TELEMETRY|telemetryDisabled|analyticsEnabled|DO_NOT_TRACK` по repo — ноль продуктовых совпадений. Консента при первом запуске нет. **[Observed absence]**
- **Experiment flags / A-B.** A/B-фреймворка нет (grep `a/b test|experiment (flag|group)|bucket|assignment` даёт только несвязанные совпадения). Есть remote config через `/api/v1/client/configs`: `dynamicWorkflow.mode` (`dynamic-workflow-feature.ts:4-23`), `pluginStoreOrder`, `uiPluginRecommendations`, `zsrc` (`packages/shared/src/clientConfig.ts:5-8,29-52`), `enable_offpeak_task` (`bigmodelCodingPlanSubscriptionProvider.ts:169,1562`), `forceUpdate.minimalVersion` (`forceUpdateGuard.ts:13,73,163`). Env-override — `ZCODE_DYNAMIC_WORKFLOW_MODE` (`dynamic-workflow-feature.ts:16-22`). **[Inference]** Это feature-gating/remote-config, но не экспериментная платформа с рандомизацией и assignment.

### 3.7. Update/distribution mechanics (Observed)

- **Каналы.** `stable` vs `preview` определяется `receivePreviewUpdates` (`packages/desktop/src/main/autoUpdater.ts:777-790`), нормализация и API-параметр `channel` (`manifestUpdateProvider.ts:36-41,91`); UI-тумблер и его обработчик — `SettingsPage.tsx:832-833,1385-1401`; copy-спека — `docs/settings-preview-updates-copy.md:1-20`.
- **Version messaging.** Пост-апдейт release notes: `pendingPostUpdateReleaseNotes` (`validationAppSettings.ts:74-85,580`), локализация `getLocalizedUpdateReleaseNotes` (`packages/ui/src/updateReleaseNotes.ts:8-27`), UI `UpdateStatusButton.tsx:106-165`, диалог `UpdateStatusDialog.tsx:140-170`.
- **Changelog.** Help → What's New → внешний `/cn/changelog` или `/en/changelog` (`desktopCommandHandlers.ts:452-467`; меню `desktopApplicationMenu.ts:278-283`). Только zh/en; для ru-RU ссылка уйдёт на `/en/changelog` (`:459`).
- **Feedback.** Help → Feedback (`desktopApplicationMenu.ts:348-352`; команда `desktopCommandHandlers.ts:606`), UI `FeedbackHost` (`packages/ui/src/App.tsx:45,1178`), 16 UI-тестов feedback.
- **Force update.** `ForceUpdateConfig { minimalVersion }` (`coding-plan-subscription.ts:187-189`); парсер semver с сокращёнными версиями (`packages/shared/src/forceUpdate.ts:22-58`); main-гейт `forceUpdateGuard.ts:13,73,163`.
- **Preview build.** В Preview-сборке updater/manual check отключён (`desktopCommandHandlers.ts:596-601`).

### 3.8. UX-поверхности и i18n (Observed)

- **Settings sections.** `general, appearance, modelProvider, memory, subagents, plugin, mcp, skill, commands, automations, hooks, browser, remoteDevices, computerUse, shortcuts, workspaceFileSearch, usage, codeGraph, archives` (`settingsPageConfig.ts:60-190`). Отдельных секций Billing / Privacy / Telemetry нет; billing-поверхности встроены в `modelProvider`.
- **Marketplace UI.** Store page внутри Settings → plugin; список/деталь/manage в одном контейнере (`docs/plugin-marketplace-ui-ux.md:104-127`; `PluginStorePage.tsx:640-657`), Side Pane market reuse (`PluginStorePage.tsx:126-135`, `embedded`).
- **Billing UI.** Встроенный webview + plan cards/quota panels; `CodingPlanEmbeddedWebviewDialog` (title/close/150% banner; `docs/coding-plan-webview-bridge.md:15-20`), `CodingPlanUpgradeDialog`, `CodingPlanUsageNotice`, `CodingPlanContextUsage`, `StartPlanCard`, `StartPlanQuotaStatusCard`.
- **Onboarding UI.** `OccupationOnboarding`, `OnboardingDialog` (welcome/migration wizard/finish), WelcomeScreen.
- **i18n.** Три локали: `en-US.ts`, `zh-CN.ts`, `ru-RU.json` (`packages/ui/src/i18n/IntlProvider.tsx:21-27`). Ad-hoc сравнение ключей: en 7501, zh 7503, ru 7503; missing in zh: 0; missing in ru: 0; `settings.plugins` — 283/283/283; `settings.modelProvider` — 608/608; `onboarding` — 62/62. **[Observed]** Полное покрытие ключей, но семантика/качество перевода не проверялись.
- **Ограничения локализации в продуктовых механиках.** Coding Plan webview принудительно маппит ru-RU → `en-US` (`packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:80-81,113-124`); changelog — только zh/en (`desktopCommandHandlers.ts:459`). About dialog ru-RU есть (`packages/desktop/src/main/about.ts:83-88`).
- **Orphan i18n.** В enterprise-блоке 72 ключа, но UI использует только tier-подстановку (`codingPlanEnterpriseTiers.ts:46`); ключи `...enterprise.seats`, `...seatInputUnit`, `...seatQuantity`, `...startPlan.highlight.trial.label`, `...purchase.teamDescription` — `UNUSED` по ad-hoc проверке. **[Observed]**

### 3.9. Тесты: инвентаризация (Observed, без исполнения)

- **UI (`packages/ui/test`, 1069 файлов).**
  - plugin: 45 файлов, включая `pluginStore.test.ts` (7 it), `pluginStoreListing.test.ts`, `pluginStorePaidPlanBadge.test.ts` (3), `officialMarketplaceAutoRefresh.test.ts` (6), `pluginStoreCardRestorable.test.ts`, `pluginManagementStore*.test.ts`.
  - plan/entitlement/quota: 37 файлов, включая `codingPlanEntitlements.test.ts` (6), `usageEntitlementAuthority.test.ts` (5), `codingPlanFunnelTelemetry.test.ts` (4), `enterpriseCodingPlanProducts.test.ts` (11), `enterpriseProductsAuth.test.ts`, `enterpriseStaticOnly.test.ts`.
  - onboarding: 6 файлов, включая `useOnboardingTrigger.test.ts` (12), `occupationOnboardingTelemetry.test.ts` (9), `onboardingAutoScan.test.ts`.
  - telemetry: 23 файла; feedback: 16; update/release: 14, включая `postUpdateReleaseNotesDialog.test.ts`, `rootUpdateReadyOverlay.test.ts`, `updateStatusButton.test.ts`.
- **Services.** `packages/services/test/pluginManagementService.test.ts` — 10 it, включая terminal telemetry, diagnostics-as-success, dryRun, no-op uninstall, cancellation, batch partial, concurrent duration isolation (`pluginManagementService.test.ts:6-227`). `telemetryPrivacy.test.ts`, `telemetryDeliveryReliability.test.ts`, `telemetryDeviceMid.test.ts`.
- **CLI adapters.** `marketplace-listing.test.ts`, `version-compare.test.ts`, `official-marketplace.test.ts`, `offline-preview-marketplace.test.ts`, `plugin-mcp-*`, `skill-marketplace.test.ts`; bootstrap — 14 plugin/marketplace тестов (`plugins.test.ts`, `plugins-protocol.test.ts`, `official-plugin-seed-lock.test.ts`, `bundled-plugins-resilience.test.ts` и др.).
- **E2E.** `packages/desktop/test/e2e/plugins/manual-review/pending` — 18 сценариев, включая `plugin-lifecycle-telemetry.test.ts`, `plugin-store-auto-refresh-on-enter.test.ts`, `plugin-store-auto-refresh-throttled.test.ts`, `plugin-cdn-zip-marketplace-install.test.ts`, `plugin-management-*`. Onboarding: helper `packages/desktop/test/e2e/helpers/occupation-onboarding.ts` и pending `mobile-remote-onboarding.mjs`. Coding plan: 4 файла `packages/desktop/test/e2e/coding-plan-*.test.ts`.
- **Вывод по покрытию.** Контракты store/плагинов и entitlement-хуков покрыты плотно; consent/opt-out телеметрии, account switching, org/seat UI, compatibility metadata и formal-CI marketplace E2E отсутствуют (см. §4).

## 4. Gaps, risks, weaknesses

Формулировки ниже — синтез evidence из §3; степень уверенности указана.

### 4.1. Документальная целостность продукта

- **`CONTEXT.md` рассинхронизирован с кодом и UI-spec по Recommended и Try now** (`CONTEXT.md:50-52,73-75` против `recommendedPlugins.ts:3-9` и `PluginStoreDetailView.tsx:160-171`). Для «единственного источника истины» это прямая угроза: новые разработчики будут реализовывать снятые механики. **[Observed]**
- **Сегменты `skills`/`catalog` не описаны ни в `CONTEXT.md`, ни в `docs/plugin-marketplace-ui-ux.md`**, хотя рендерятся (`PluginStoreListView.tsx:37,189-196,237-244`) и имеют i18n (`en-US.ts:5401-5402`). **[Observed]**
- **Native purchase flow удалён, но docs/specs частично описывают его как действующий** (`docs/coding-plan-purchase-panel-flow.md:1-60` описывает state machine `planSelect→…→success`; `codingPlanPricingCards.ts:4-6` фиксирует удаление, `docs/coding-plan-purchase-funnel-telemetry.md:352` — «原 CodingPlanPurchasePanel.tsx 已于 2026-09 删除»). **[Observed]** Риск: команда будет искать несуществующий UI.
- **Enterprise-контракт и i18n существуют, UI-часть не подключена**: order API есть (`codingPlanSubscription.ts:100-130`), seat-строки в i18n есть, но seat-степпера и order-вызовов в UI нет. **[Observed]** Это создаёт иллюзию реализованной enterprise-механики.

### 4.2. Монетизация и upgrade paths

- **Нет self-serve управления подпиской**: отмена/возобновление/смена плана уводятся на внешний сайт; в продукте нет даже чтения статуса renewal. Документ прямо фиксирует out-of-scope: cancel/renew/list pending orders/member seats (`docs/coding-plan-enterprise.md:70-72`). **[Observed]**
- **Нет лицензионных ключей/офлайн-активации** — grep пуст. Для enterprise-закупок это означает зависимость от онлайн-аккаунта. **[Observed absence]**
- **Paywall фрагментирован**: quota-блокировка (`SessionPane.tsx:5567`) + upgrade-баннер (`sessionQuotaBannerState.ts:306`) + провайдер-гейтинг + внешние URL; единого «плана/сравнения/лимитов» экрана нет (native panel удалён). **[Inference]**
- **`requiresPaidPlan` легко принять за коммерческий gating**, хотя это только badge (`contracts:137-141`; `docs/plugin-marketplace-ui-ux.md:335-338`). Риск неверных ожиданий у авторов каталога. **[Observed]**
- **Пробный Start Plan не имеет клиентского жизненного цикла** (нет trial start/end state, только remote preview + `startPlanExpired`). Остались неиспользуемые trial-строки i18n. **[Observed]**

### 4.3. Marketplace trust и качество каталога

- **Нет верификации издателя, подписей, provenance, in-app moderation** (§3.5). Единственные барьеры — sha256 для zip и доверие к id официального маркета (`marketplace.ts:76,416-453`). Для personal sources (git/URL/local) целостность зависит от пользователя. **[Observed]**
- **Нет compatibility metadata** (`engines`/`minAppVersion`) — установка не может заранее отклонить плагин, несовместимый с версией приложения (`contracts:144-166`). **[Observed absence]**
- **Нет отмены установки в UI** и **нет validate/diagnose источника** — оба зарегистрированы как bug candidates (`docs/plugin-marketplace-ui-ux.md:90-94`). **[Observed]**
- **Отсутствие install counts/ratings — осознанный выбор** (`docs/plugin-marketplace-ui-ux.md:82`; `pluginCatalogModel.ts:13-24`), но означает, что discovery опирается только на курацию (`featured`, категории) и поиск. **[Inference]**
- **Community-контент приходит из внешнего publishing-репозитория**, которого нет в этой кодовой базе; клиент доверяет полю `publisherType` из манифеста. Модерация не проверяема из этого repo. **[Observed/Unknown]**

### 4.4. Onboarding и активация

- **Нет guided-шага открытия проекта и настройки модели/провайдера**: wizard собирает occupation/mode/preferences/import, но не доводит до первого успешного task с рабочим провайдером (`OnboardingDialog.tsx:38-45`). Это классический activation-gap. **[Observed для состава шагов; Inference для влияния на активацию]**
- **Onboarding fail-closed**: таймаут/ошибка record-сервиса →引导 не показывается (`useOnboardingTrigger.ts:44,52,63,106-111`). Для новых пользователей при сбое это «тихий» пропуск onboarding без компенсации. **[Observed]**
- **Onboarding-запись не выгружается** (`uploadState: "pending"`, `docs/onboarding-record-spec.md:296-305`) — серверная аналитика воронки опирается только на события `onboarding_expose/end`, а не на локальный record. **[Observed]**
- **Нет tips/coachmarks/tour** — открытие возможностей (shortcuts, command palette, marketplace) не проактивно. **[Observed absence]**
- **Импорт из других инструментов неполный**: plugins-import выключен (`OnboardingDialog.tsx:43,94`), proxy-шаг выключен (`docs/onboarding-external-agent-import-steps.md:8-12`). **[Observed]**

### 4.5. Telemetry privacy и эксперименты

- **Нет пользовательского consent/opt-out для продуктовой телеметрии** — только build-time отключение endpoint (§3.6). Для продуктов с глобальной дистрибуцией это регуляторный и репутационный риск (GDPR/CCPA-подобные режимы). **[Observed absence; Inference для риска]**
- **Нет согласия на аналитику при первом запуске**: onboarding показывает wizard, но не consent-шаг (`OnboardingDialog.tsx:38-45`). **[Observed]**
- **Нет A/B-платформы**: remote config есть, но рандомизации/assignment/bucketing нет (§3.6). Рост-эксперименты придётся делать вручную через `client/configs`, без гарантий стабильности выборки. **[Inference]**
- **Нет account deletion / data export** (§3.3) — только локальный Clear All Data и Export Logs. **[Observed absence]**

### 4.6. Обновления и распределение

- **Changelog и release notes не локализованы на ru-RU** (`desktopCommandHandlers.ts:459`; `codingPlanEmbeddedWebview.ts:81`), хотя продукт имеет ru-локаль. **[Observed]**
- **Force update минимальная версия приходит из remote config** (`forceUpdateGuard.ts:13,73,163`), но связка «почему эта версия обязательна / что сломается» в UI ограничена текстом (`en-US.ts:2215-2217`). **[Observed]**
- **Preview-канал управляется одним boolean** (`receivePreviewUpdates`), без channel-specific release notes/rollback-механик в клиенте. **[Observed]**

## 5. Strengths and differentiators

- **Строгий контракт каталога и запрет фабриковать метрики.** `docs/catalog-leaderboard.md:11-22` и `pluginCatalogModel.ts:13-24` явно запрещают выдуманные installs/downloads/ratings; UI честно показывает curated ordering. Это снижает риск манипулятивной витрины. **[Observed]**
- **Богатая lifecycle-модель плагинов с восстановлением и orphan-состоянием.** Restorable Builtin (`bootstrap/src/plugins.ts:341-347,660-668,905-929`), orphaned installed (`pluginStoreListing.ts:280-332`), разделение user/workspace scope (`docs/plugins/plugin-market-interactions-scope.md:10-19`). **[Observed]**
- **Безопасность цепочки поставки для официального канала.** Единый official marketplace id, защита от подмены id, sha256-zip, offline-preview запрет CDN (`marketplace.ts:76,396-453,707-708,2632-2634`). **[Observed]**
- **Плотная телеметрия жизненного цикла и воронок с privacy-whitelist.** `plugin_lifecycle/discovery/usage/runtime_error` (`telemetry.ts:56-113`), coding plan funnel (`codingPlanFunnelTelemetry.ts:168-199`), onboarding events (`useOnboardingTelemetry.ts:55-124`), редактирование `error_msg/login_url` (`event-report-privacy.md:8-20`). **[Observed]**
- **Продуманный fail-closed onboarding.** 3-секундный бюджет, запрет settings-fallback, anonymous-record claim — с документированными инцидентами и регрессиями (`docs/onboarding-record-spec.md:97-147,228-258`; `useOnboardingTrigger.ts:1-20,44-70`). **[Observed]**
- **Quota enforcement доведён до composer.** `blocksSubmit` реально отключает ввод (`SessionPane.tsx:5555-5571`), а не только рисует баннер. **[Observed]**
- **Единая модель entitlements для personal/team/start и MCP quota** с in-flight dedupe и TTL-кэшем (`usage-stats.ts:78-101`; `useUsageEntitlement.ts:50-90`; `usageEntitlementCache.ts:4-31`). **[Observed]**
- **Хорошая i18n-полнота ключей** (en/zh/ru = 7501/7503/7503, zero missing) при трёх локалях. **[Observed]**
- **Плотные unit/service тесты вокруг plugin lifecycle и телеметрии** (45 UI plugin-файлов; 10 service it; 14 bootstrap-тестов). **[Observed]**

## 6. Candidate recommendations

Ниже — только внутренние улучшения ZCode; внешние продукты не сравниваются. Поля обязательны для каждой рекомендации.

### R1. Синхронизировать `CONTEXT.md` с фактическим store и purchase flow

- **Problem/gap.** `CONTEXT.md` описывает снятый Recommended и удалённый Try now, не знает сегментов skills/catalog (`CONTEXT.md:50-52,73-75`; `recommendedPlugins.ts:3-9`; `PluginStoreDetailView.tsx:160-171`; `PluginStoreListView.tsx:37,189-196`).
- **ZCode evidence.** `CONTEXT.md:50-52`, `CONTEXT.md:73-75`, `packages/ui/src/settings/recommendedPlugins.ts:3-9`, `packages/ui/src/settings/PluginStoreDetailView.tsx:160-171`, `packages/ui/src/settings/PluginStoreListView.tsx:37,189-196`, `docs/plugin-marketplace-ui-ux.md:212,232-237`.
- **Proposed solution.** Обновить словарь: Recommended → «снят» с датой и ссылкой на решение; Example Prompt → описать сосуществование с Try now (или удалить Try now из кода, если решение обратное); добавить термины Skills Segment и Catalog Segment с определениями и границами.
- **Scope / out-of-scope.** In: только `CONTEXT.md` и ссылки. Out: изменение UI-поведения, переименование кода, миграции.
- **Expected effect.** Устраняется главный источник неверных реализаций; ревью PR смогут ссылаться на актуальный словарь.
- **Risks.** Если решение по Try now не зафиксировано, правка словаря закрепит неверную сторону. Нужен owner-подтверждённый ответ (см. §7 Q1).
- **Complexity.** S.
- **Priority.** P0.
- **Acceptance criteria.** Для каждого из 17 терминов словаря существует либо совпадающий символ/поле, либо явная пометка «снято/запланировано» с датой; в `CONTEXT.md` нет термина без ссылки на реализацию или решение.
- **Verification method.** `rg` по каждому термину из `CONTEXT.md` в `packages apps docs`; ручная сверка списка терминов с `pluginStoreListing.ts`, `contracts/src/plugins/index.ts`, `PluginStoreDetailView.tsx`.

### R2. Ввести единый экран «план, лимиты и управление подпиской»

- **Problem/gap.** Нет self-serve управления подпиской и единого обзора плана; upgrade разбросан по баннерам, а управление уводится на внешний URL (`sessionQuotaBannerState.ts:306-308`; `model-provider-family.ts:35,45`; `docs/coding-plan-enterprise.md:70-72`).
- **ZCode evidence.** `packages/ui/src/v4/sessionQuotaBannerState.ts:306-308`, `packages/ui/src/v4/SessionPane.tsx:5555-5571`, `packages/shared/src/model-provider-family.ts:35,45`, `packages/shared/src/usage-stats.ts:78-135`, `docs/coding-plan-enterprise.md:70-72`.
- **Proposed solution.** Добавить секцию Settings → Plan (или вкладку внутри `modelProvider`): текущий план, остаток quota по бакетам, дата сброса, команда «Manage» (внешний URL), список доступных апгрейдов, единый CTA upgrade. Использовать уже существующий `UsageEntitlementSnapshot` и `shouldOfferQuotaBannerUpgrade`.
- **Scope / out-of-scope.** In: read-only обзор + навигация + CTA. Out: собственный checkout, отмена/возобновление подписки, seat-степпер, биллинг-история.
- **Expected effect.** Один detour вместо N разрозненных баннеров; снижение неопределённости «что у меня за план и сколько осталось».
- **Risks.** Дублирование данных с уже существующими карточками provider; рассинхрон между snapshot и внешним сайтом. Нужен единый owner состояния — `useUsageEntitlement`.
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** Для personal/start/team план-статусов экран показывает план, остаток, reset, доступные действия; при `no_plan`/`unavailableReason` — честное состояние без выдуманных лимитов; все тексты в трёх локалях.
- **Verification method.** Component-тесты на все `unavailableReason`/`startPlanExpired`/`teamPlanUnavailableReason`; ручная проверка с реальным snapshot; `pnpm typecheck`, `pnpm lint`, targeted vitest.

### R3. Достроить trust-сигналы marketplace без фабрикации метрик

- **Problem/gap.** Нет verification издателя, compatibility metadata и in-app moderation-сигналов; sha256 покрывает только официальный zip (`marketplace.ts:76,2632-2634`; `contracts/src/plugins/index.ts:144-166`).
- **ZCode evidence.** `apps/zcode-cli/packages/contracts/src/plugins/index.ts:115-166`, `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:76,416-453,2632-2634`, `packages/ui/src/settings/pluginCatalogModel.ts:13-40`, `docs/catalog-leaderboard.md:11-22`, `docs/plugins/plugin-market-interactions-scope.md:21-56`.
- **Proposed solution.** Расширить `Store Listing`/manifest опциональными полями `minAppVersion` (или `engines`) и `publisherVerification` (enum + URL доказательства), добавить UI-бейдж и проверку при install с диагностикой `plugin_incompatible_app_version`. Не вводить install counts/ratings.
- **Scope / out-of-scope.** In: поля, парсинг, диагностика, badge, тесты. Out: собственная модерация, рейтинги, revenue share, подписи пакетов.
- **Expected effect.** Пользователь видит, что плагин несовместим, до установки; официальный/community статус перестаёт быть единственным сигналом доверия.
- **Risks.** Новые поля требуют публикации каталога; старые каталоги должны деградировать (поля optional, отсутствие = текущее поведение). Нельзя превращать verification в скрытый gating.
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** Каталог без новых полей работает как раньше; при `minAppVersion > ZCODE_VERSION` установка блокируется с локализованной диагностикой; бейдж verification отображается только при явном значении; тесты на парсинг невалидных значений.
- **Verification method.** Adapter-тесты на parse/diagnostics; UI-тесты card/detail; bootstrap protocol-тест; ручная проверка на fixture-каталоге.

### R4. Закрыть install-cancel и source-validate (bug candidates)

- **Problem/gap.** Кнопка install только disabled, отмены нет; sources dialog не умеет validate, хотя протокол/адаптер это позволяют (`PluginStoreCard.tsx:187-226`; `PluginStoreSourcesDialog.tsx:49-57,132,151`).
- **ZCode evidence.** `packages/ui/src/settings/PluginStoreCard.tsx:187-226` (`disabled={installing}` `:209`), `packages/ui/src/settings/PluginStoreSourcesDialog.tsx:49-57,132,151`, `apps/zcode-cli/packages/bootstrap/src/plugins.ts` (validate/describe handlers), `docs/plugin-marketplace-ui-ux.md:90-94`.
- **Proposed solution.** Добавить cancel-кнопку в installing-состояние с вызовом `cancelPluginOperation` (сервис уже есть, `pluginManagementService.ts:193`), и кнопку Validate для personal source с отображением diagnostics.
- **Scope / out-of-scope.** In: UI-действия + тесты. Out: изменение протокола, новые backend-операции.
- **Expected effect.** Устраняются два зафиксированных bug candidate; снижается риск «залипшей» установки и невалидного источника.
- **Risks.** Отмена может прийти в момент финализации; нужно использовать существующие operationId и не вводить второй источник истины.
- **Complexity.** S.
- **Priority.** P1.
- **Acceptance criteria.** Во время install доступна Cancel; после отмены состояние возвращается в не-installed без потери существующей установки; Validate показывает diagnostics или «источник валиден»; ни один сценарий не оставляет busy-state.
- **Verification method.** UI unit-тесты на cancel/validate; service-тест на cancellation; ручной E2E на fixture-маркете.

### R5. Добавить consent/opt-out и прозрачность продуктовой телеметрии

- **Problem/gap.** Нет пользовательского consent/opt-out; единственный выключатель — build-time endpoint (`telemetryCore.ts:419`; grep по `DO_NOT_TRACK|telemetryDisabled` пуст).
- **ZCode evidence.** `packages/services/src/telemetry/telemetryCore.ts:419`, `packages/shared/src/env.ts:60-64`, `packages/shared/src/validationAppSettings.ts:560-590`, `docs/monitoring/event-report-privacy.md:8-36`, `packages/ui/src/onboarding/OnboardingDialog.tsx:38-45`.
- **Proposed solution.** Ввести persisted setting `telemetryEnabled` (default on для production, off для dev) + чекбокс в onboarding/финальном consent-шаге и в Settings → General/Privacy; при выключении `TelemetryCore` прекращает отправку (кроме локального state). Добавить страницу «что отправляется» со ссылкой на каталог событий.
- **Scope / out-of-scope.** In: consent UI, настройка, gate в `sendReport`, документация. Out: изменение существующих событий, серверная очистка исторических данных, ARMS/OTLP (отдельный контур).
- **Expected effect.** Управляемый privacy-контур, снижение регуляторного риска; честная коммуникация.
- **Risks.** Отключение телеметрии ухудшит метрики; нужно различать product telemetry и crash/ARMS. Нельзя скрыто игнорировать opt-out ради retention.
- **Complexity.** M.
- **Priority.** P0.
- **Acceptance criteria.** При `telemetryEnabled=false` ни один `/event/report` не отправляется (тест на fetch-mock); настройка переживает рестарт; onboarding consent фиксируется до первого события; документация перечисляет категории событий.
- **Verification method.** Unit-тесты `TelemetryCore` на gate и persisted setting; integration с mock endpoint; UI-тест consent-шага; ручная проверка в desktop.

### R6. Достроить activation-путь: проект + провайдер + первый task

- **Problem/gap.** Onboarding не ведёт к первому успешному task: нет шага открытия проекта и настройки провайдера (`OnboardingDialog.tsx:38-45`; `settingsPageConfig.ts:72-77`).
- **ZCode evidence.** `packages/ui/src/onboarding/OnboardingDialog.tsx:38-45`, `packages/ui/src/onboarding/OccupationOnboarding.tsx:65-233`, `packages/ui/src/Root.tsx:313,674-675`, `packages/ui/src/settings/model-provider-section/Detail.tsx` (provider UI), `packages/ui/src/v4/featureSuggestedPrompts.ts:18,565-568`.
- **Proposed solution.** После occupation/preferences добавить два опциональных шага: «Open a project» (DirectoryBrowser) и «Connect a model provider» (OAuth/API key) с skip; финальный шаг — предложить 1–2 sample task из пула по режиму и открыть draft с предзаполненным prompt (без авто-отправки). Использовать существующие `onCreateTask`/prefill-контракты.
- **Scope / out-of-scope.** In: onboarding-шаги и wiring. Out: автоматическая отправка prompt, автовыбор модели, изменение provider-модели.
- **Expected effect.** Рост активации (первый task в первой сессии), снижение «пустого» первого запуска.
- **Risks.** Удлинение wizard повышает drop-off; шаги должны быть skippable. Провайдер-настройка может конфликтовать с уже существующим login-экраном.
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** Новый пользователь может пройти onboarding → открыть проект → подключить провайдера → получить draft с sample prompt; любой шаг можно пропустить; повторный запуск не дублирует шаги; состояние сохраняется в `onboarding-record.json`/settings.
- **Verification method.** Component-тесты шагов; pending E2E `mobile-remote-onboarding` расширить desktop-сценарием; ручная проверка на чистом профиле.

### R7. Ввести лёгкий экспериментный контур поверх `client/configs`

- **Problem/gap.** Remote config есть, но нет assignment/bucketing, поэтому growth-эксперименты невоспроизводимы (`clientConfig.ts:5-8,29-52`; `dynamic-workflow-feature.ts:4-23`).
- **ZCode evidence.** `packages/shared/src/clientConfig.ts:5-8,29-52`, `packages/shared/src/dynamic-workflow-feature.ts:9-23`, `packages/services/src/client-config/clientConfigService.ts:70`, `docs/monitoring/*` (нет experiment-документа).
- **Proposed solution.** Добавить в snapshot可选 `experiments: Record<string, {variant: string; bucket: number}>`, вычисляемый детерминированно по `deviceMid`/`userId`; в UI — helper `useExperiment(key, defaultVariant)`. Не вводить сторонний SDK.
- **Scope / out-of-scope.** In: контракт, стабильный bucketing, helper, логирование variant в telemetry. Out: серверная панель экспериментов, авто-stop по метрикам.
- **Expected effect.** Возможность проверять onboarding-шаги, store-layout и upgrade-копирайт на когортах с воспроизводимым распределением.
- **Risks.** Неверный bucketing даст смещённые результаты; variant нужно логировать вместе с событиями; privacy — не добавлять новые идентификаторы.
- **Complexity.** M.
- **Priority.** P2.
- **Acceptance criteria.** Один и тот же `deviceMid` всегда получает одинаковый variant; отсутствие поля = default; variant попадает в `event_extra_detail` whitelisted-полем; тесты на стабильность распределения.
- **Verification method.** Unit-тесты bucketing (детерминизм, равномерность на N=10k); тест парсинга snapshot; интеграционный тест с mock `client/configs`.

### R8. Локализовать distribution-поверхности на ru-RU

- **Problem/gap.** Changelog только zh/en, coding-plan webview принудительно en для ru (`desktopCommandHandlers.ts:459`; `codingPlanEmbeddedWebview.ts:80-81`).
- **ZCode evidence.** `packages/desktop/src/main/desktopCommandHandlers.ts:452-467`, `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:78-81,113-124`, `packages/ui/src/i18n/IntlProvider.tsx:21-27`.
- **Proposed solution.** Добавить ru-маршрут changelog при наличии; для webview — передавать `lang=ru` только если официальный сайт поддерживает, иначе явно показывать, что страница на английском (честное сообщение вместо тихого переключения).
- **Scope / out-of-scope.** In: locale mapping и copy. Out: перевод внешнего сайта, изменение платёжного контракта.
- **Expected effect.** Отсутствие скрытого языкового переключения; понятная коммуникация для ru-пользователей.
- **Risks.** Если сайт не поддерживает ru, `lang=ru` ухудшит страницу; нужен fallback + явная подсказка.
- **Complexity.** S.
- **Priority.** P2.
- **Acceptance criteria.** Для ru-RU changelog ведёт на существующую локаль или явно сообщает о языке; coding-plan webview не меняет язык молча; тесты на mapping.
- **Verification method.** Unit-тесты `resolveChangelogUrl`/`createCodingPlanLangInjectionScript`; ручная проверка ссылки и webview.

## 7. Open questions and unverified

1. **Q1. Какой источник истины для Try now?** `CONTEXT.md:73-75` говорит «удалён», код и UI-spec — «есть». Нужен owner-ответ: удалить код или обновить словарь. **[Unknown]**
2. **Q2. Является ли `catalog`/`skills` сегмент намеренным продуктом?** Рендер и i18n есть, документации нет. Возможно, экспериментальная поверхность. **[Unknown]**
3. **Q3. Enterprise-закупка: UI сознательно не подключён или это незавершённая миграция?** Order API + i18n есть, вызовов нет; `docs/coding-plan-enterprise.md` описывает полный flow, но native panel удалён. **[Unknown]**
4. **Q4. Consent/opt-out телеметрии — продуктовое решение или пропуск?** Ни в docs, ни в коде нет ни требования, ни запрета. **[Unknown]**
5. **Q5. Есть ли серверная модерация/verification маркета вне этого repo?** `external_plugins/` и review-пайплайн упомянуты, но сам publishing-репозиторий не входит в workspace. **[Unknown]**
6. **Q6. Реально ли работает auto-refresh официального CDN в production?** Код и throttle-тесты есть, но публичный CDN не проверялся; lifecycle-case `PLM-LC-019` помечен `never formal CI` (`docs/plugin-management-lifecycle-case-catalog.md:61-65`). **[Unverified]**
7. **Q7. Работает ли install-cancel на уровне протокола end-to-end?** `cancelPluginOperation` есть в сервисе, но UI-пути нет; protocol-тесты покрывают сервис, не UI. **[Unverified]**
8. **Q8. Как ведёт себя onboarding при отключённом record-сервисе на mobile/home-only?** Спека прямо называет это известным ограничением (`docs/onboarding-record-spec.md:255-258`); runtime не проверялся. **[Unverified]**
9. **Q9. Применяется ли `requiresPaidPlan` в каком-либо скрытом gating?** По коду — только badge; серверная сторона не проверялась. **[Unverified]**
10. **Q10. Есть ли account-switching через повторный OAuth поверх существующей сессии?** Косвенно возможно (logout → login), но отдельного UI нет. **[Unknown]**

Отдельно: **все** утверждения об отсутствии (license checks, ratings, revenue share, verification, consent, A/B, org membership, account deletion) основаны на адресном grep по терминам и не являются доказательством отсутствия серверных или генерируемых путей.

## 8. Evidence appendix

### 8.1. Preflight-вывод (точный)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

### 8.2. CodeIndex

```json
{"state":"ready","partial":false,"generation":1456,
 "counts":{"files":10007,"chunks":26791,"symbols":278154,"edges":377669}}
```

Индекс использован как указатель; load-bearing факты подтверждены чтением файлов.

### 8.3. Ключевые file:line по темам

**Домен/словарь**
- `CONTEXT.md:1-3,9-89` — словарь.
- `apps/zcode-cli/packages/contracts/src/plugins/index.ts:7` — official marketplace id.
- `packages/ui/src/settings/recommendedPlugins.ts:3-9` — Recommended снят.
- `packages/ui/src/settings/PluginStoreListView.tsx:37,167-196,237-244` — 5 сегментов.
- `packages/ui/src/settings/PluginStoreDetailView.tsx:160-171` — Try now.
- `docs/plugin-marketplace-ui-ux.md:82,90-94,212,232-237,331-342` — non-goals, bug candidates, Recommended, Try now, requiresPaidPlan.

**Монетизация/entitlements**
- `packages/shared/src/coding-plan-subscription.ts:7-15,118-185,429-590`.
- `packages/shared/src/usage-stats.ts:78-135`.
- `packages/ui/src/hooks/useUsageEntitlement.ts:50-90`.
- `packages/ui/src/lib/usageEntitlementCache.ts:4-31`.
- `packages/ui/src/v4/sessionQuotaBannerState.ts:20-52,306-308`.
- `packages/ui/src/v4/SessionPane.tsx:5555-5571`.
- `packages/ui/src/settings/model-provider-section/StartPlanCard.tsx:17-40`.
- `packages/ui/src/settings/model-provider-section/codingPlanPricingCards.ts:4-6`.
- `packages/ui/src/settings/CodingPlanUpgradeDialog.tsx:66-150`.
- `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:78-126`.
- `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts:100-130`.
- `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts:634-699,1562`.
- `packages/shared/src/model-provider-family.ts:9-36,35,45`.
- `docs/coding-plan-enterprise.md:5-32,70-72`.
- `docs/model-provider-coding-plan-availability.md:21-27`.

**Auth/accounts/privacy**
- `packages/shared/src/oauth.ts:9-12,56-67`.
- `packages/services/src/oauth/providers/zaiProviderConfig.ts:16-19`, `bigmodelProviderConfig.ts:14-17`.
- `packages/ui/src/WelcomeScreen.tsx:320-368`.
- `packages/ui/src/login/LoginApiKeyForm.tsx:45-48,131,280`.
- `packages/ui/src/WorkspaceSidebarFooter.tsx:143-166,280-310,455-470`.
- `packages/ui/src/i18n/locales/en-US.ts:4330`, `zh-CN.ts:4047` (orphan switch-account key).
- `packages/shared/src/zcode-protocol/index.ts:1208-1219` (org/project только в team access).
- `packages/shared/src/validationAppSettings.ts:560-590` (нет telemetry toggle).
- `packages/desktop/src/main/desktopCommandHandlers.ts:83-130,616-618`.
- `packages/shared/src/feedbackPrivacy.ts:1-90`; `packages/shared/src/telemetry.ts:216-241`.

**Onboarding**
- `packages/ui/src/onboarding/OccupationOnboarding.tsx:65,89,197-233`.
- `packages/ui/src/onboarding/useOnboardingTrigger.ts:22-134`.
- `packages/services/src/onboarding/onboardingRecordService.ts:29,74-240`.
- `packages/services/src/onboarding/onboardingRecord.ts:19-50`.
- `docs/onboarding-record-spec.md:1-53,97-147,228-258,296-305`.
- `packages/ui/src/onboarding/OnboardingDialog.tsx:38-45,94`.
- `packages/ui/src/onboarding/useOnboardingTelemetry.ts:55-124`.
- `docs/monitoring/onboarding-telemetry.md:1-60`.
- `packages/ui/src/v4/featureSuggestedPrompts.ts:18,565-568`.
- `packages/ui/src/v4/SessionPane.tsx:5767`.
- `packages/ui/src/settings/PluginInstallEmptyState.tsx:1-36`.
- `packages/ui/src/Root.tsx:313,674-675`.
- `packages/ui/src/SettingsPage.tsx:1761-1777`.
- `packages/shared/src/shortcutCommands.ts:102`.
- `packages/ui/src/quickpick/quickPickCommands.ts:42,77-140`.
- `docs/onboarding-external-agent-import-steps.md:1-30`.

**Marketplace**
- `apps/zcode-cli/packages/contracts/src/plugins/index.ts:7,115-166`.
- `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:76,120,410,716,815,830,1303,2270-2285,2323-2324,2632-2634`.
- `apps/zcode-cli/packages/adapters/src/plugins/version-compare.ts:12-45`.
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts:263,341-347,660-668,905-929`.
- `packages/services/src/plugins/pluginManagementService.ts:96-207`.
- `packages/services/src/plugins/pluginManagement.ts:96-120`.
- `packages/shared/src/zcode-protocol/index.ts:4698-4709`.
- `packages/ui/src/settings/PluginStorePage.tsx:126-135,170-190,222-243,368-377,407-514,785-799`.
- `packages/ui/src/settings/PluginStoreCard.tsx:48-63,120-226,232-333`.
- `packages/ui/src/settings/pluginStoreListing.ts:156-166,177-190,280-332,343-390,409-424`.
- `packages/ui/src/settings/pluginSearch.ts:1-33`.
- `packages/ui/src/settings/pluginCatalogModel.ts:13-40`.
- `packages/ui/src/settings/officialMarketplaceAutoRefresh.ts:15,25-44`.
- `packages/ui/src/settings/PluginStoreSourcesDialog.tsx:49-57,132,151`.
- `docs/monitoring/plugin-lifecycle-telemetry.md:5-43`.
- `docs/plugins/plugin-market-interactions-scope.md:10-56`.
- `docs/plugin-management-lifecycle-case-catalog.md:43-65`.

**Telemetry/experiments**
- `packages/services/src/telemetry/telemetryCore.ts:128-130,419,587-680`.
- `packages/desktop/src/main/appTelemetryRuntime.ts:40,53,72,106-114`.
- `packages/shared/src/telemetry.ts:15-113,216-241`.
- `packages/ui/src/lib/codingPlanFunnelTelemetry.ts:13-26,168-199`.
- `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:228-248`.
- `packages/shared/src/clientConfig.ts:5-8,29-52`.
- `packages/shared/src/dynamic-workflow-feature.ts:4-23`.
- `packages/desktop/src/main/forceUpdateGuard.ts:13,73,163`.
- `docs/monitoring/event-report-privacy.md:8-36`.
- `docs/monitoring/session-create-telemetry.md:1-40`.
- `docs/coding-plan-purchase-funnel-telemetry.md:1-80,352`.

**Updates/distribution**
- `packages/desktop/src/main/autoUpdater.ts:777-790`.
- `packages/desktop/src/main/manifestUpdateProvider.ts:36-41,91`.
- `packages/ui/src/SettingsPage.tsx:832-833,1385-1401`.
- `packages/shared/src/validationAppSettings.ts:74-85,580-584`.
- `packages/ui/src/updateReleaseNotes.ts:8-27`.
- `packages/ui/src/UpdateStatusButton.tsx:106-165`.
- `packages/desktop/src/main/desktopCommandHandlers.ts:452-467,586-618`.
- `packages/desktop/src/main/desktopApplicationMenu.ts:278-283,348-360`.
- `packages/shared/src/desktopMenu.ts:31-44`.
- `packages/shared/src/forceUpdate.ts:22-58`.
- `docs/settings-preview-updates-copy.md:1-20`.

**UX/i18n**
- `packages/ui/src/settings/settingsPageConfig.ts:60-190`.
- `packages/ui/src/lib/settingsNavigation.ts:4-25`.
- `packages/ui/src/i18n/IntlProvider.tsx:21-27`.
- `packages/ui/src/i18n/LocaleSwitcher.tsx:6-11`.
- `packages/desktop/src/main/about.ts:55-100`.

### 8.4. Что реально выполнялось и что нет

- **Выполнено:** `git status/branch/log`; `CodeIndex status` + адресные `search`; чтение перечисленных файлов; `wc -l`; адресные `grep/rg`; ad-hoc Node-скрипт сравнения i18n-ключей (только чтение); `ls`/`find` по каталогам тестов и плагинов; `ls external_plugins` (exit 1).
- **Не выполнялось:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, targeted vitest, desktop E2E, сборка, запуск Electron, реальные OAuth/CDN/платёжные вызовы, мобильный relay, Windows/Linux, живые CDN/manifest.

### 8.5. Coverage status

- Покрытие темы Z15: **полное для code-level инвентаризации** (все 10 пунктов конверта имеют evidence), **частичное для runtime-поведения** (не запускались тесты/UI/сеть).
- Все 8 обязательных заголовков присутствуют; capability-матрица с verdicts Present/Partial/Absent и file:line — в §3 (по подразделам) и сводно ниже.

### 8.6. Сводная матрица «Present / Partial / Absent»

| Механика | Verdict | Evidence |
| --- | --- | --- |
| Plans/tiers (Start/Individual/Team, LITE/PRO/MAX) | Present | `coding-plan-subscription.ts:9-15,429-439`; `model-provider-family.ts:9-36` |
| Entitlements snapshot | Present | `usage-stats.ts:78-135`; `useUsageEntitlement.ts:50-90` |
| Quota limits + enforcement | Present | `sessionQuotaBannerState.ts:20-52`; `SessionPane.tsx:5555-5571` |
| Billing integration | Partial (webview + service API; native order UI отсутствует) | `codingPlanEmbeddedWebview.ts:78-126`; `CodingPlanUpgradeDialog.tsx:66-150`; `codingPlanSubscription.ts:100-130`; `codingPlanPricingCards.ts:4-6` |
| Paywall | Partial (распределённый gating, нет единого экрана) | `sessionQuotaBannerState.ts:306-308`; `model-provider-coding-plan-availability.md:21-27` |
| Trial | Partial (Start Plan, нет локального lifecycle) | `StartPlanCard.tsx:17-40`; `usage-stats.ts:84-85` |
| Feature gating | Present | `SessionPane.tsx:5567`; `dynamic-workflow-feature.ts:9-23`; `bigmodelCodingPlanSubscriptionProvider.ts:1562` |
| License checks | Absent (по коду) | grep `licenseKey|activationKey` — нет продуктовых совпадений |
| Seats | Partial (типы/API есть, UI-степпера нет) | `coding-plan-subscription.ts:506-564`; grep `seatCount` в UI — пусто |
| Team/org model | Partial (org/project только в billing) | `zcode-protocol/index.ts:1208-1219`; `docs/coding-plan-enterprise.md:70-72` |
| OAuth providers | Present (zai, bigmodel) | `oauth.ts:9-12,56-59`; `providers/*Config.ts` |
| API key / skip login | Present | `WelcomeScreen.tsx:320-368`; `LoginApiKeyForm.tsx:280` |
| Org membership | Absent | grep `invite|members` — нет call-site |
| Profile | Partial (id/logout, без редактирования) | `WorkspaceSidebarFooter.tsx:280-310,455-470` |
| Account switching | Absent (только orphan i18n) | `en-US.ts:4330`; grep без locales — пусто |
| Privacy controls | Absent | `validationAppSettings.ts:560-590` |
| Account data export/delete | Absent (есть только local Clear All/Export Logs) | `desktopCommandHandlers.ts:83-130,616-618` |
| First-run wizard | Present (occupation 3 шага) | `OccupationOnboarding.tsx:65-233` |
| Project open guidance | Absent/Partial | `Root.tsx:313,674-675`; `OnboardingDialog.tsx:38-45` |
| Model/provider setup onboarding | Absent | `OnboardingDialog.tsx:38-45` |
| Sample tasks | Present | `featureSuggestedPrompts.ts:18,565-568` |
| Empty states | Present | `PluginInstallEmptyState.tsx:1-36`; `PluginStoreListView.tsx:267-272` |
| Tips/tour | Absent | grep `coachmark|tour|spotlight` — нет |
| Shortcut discovery | Partial | `ShortcutSettingsSection.tsx:39`; `shortcutCommands.ts:102` |
| Import from other tools | Partial (skills/mcp/commands; plugins off) | `OnboardingDialog.tsx:38-45,94` |
| Plugin catalog | Present | `PluginStorePage.tsx:126-514`; `PluginStoreListView.tsx:37-244` |
| Install/update/uninstall | Present | `zcode-protocol/index.ts:4698-4709`; `pluginManagementService.ts:180-207` |
| Install cancel | Absent | `PluginStoreCard.tsx:187-226` |
| Ratings/reviews/installs | Absent | `docs/plugin-marketplace-ui-ux.md:82`; `pluginCatalogModel.ts:13-24` |
| Publisher verification | Absent | grep verification/signature — пусто |
| Moderation (in-app) | Absent | `docs/plugins/plugin-market-interactions-scope.md:21-56` (внешний процесс) |
| Search (incl pinyin) | Present | `pluginSearch.ts:1-33` |
| Categories | Present | `pluginStoreListing.ts:156-166,367-390` |
| Compatibility metadata | Absent | `contracts/src/plugins/index.ts:144-166` |
| Version resolution | Present | `version-compare.ts:12-45`; `marketplace.ts:1303-1340` |
| Revenue share | Absent | grep `revenueShare|publisherRevenue` — пусто |
| Activation/retention telemetry | Present | `telemetryCore.ts:587-680` |
| Funnel telemetry | Present | `codingPlanFunnelTelemetry.ts:168-199`; `pluginManagementService.ts:96-207` |
| Experiment flags/A-B | Absent (есть remote config) | `clientConfig.ts:5-8`; `dynamic-workflow-feature.ts:9-23` |
| Telemetry consent/opt-out | Absent | `telemetryCore.ts:419`; grep — пусто |
| Preview vs stable channel | Present | `autoUpdater.ts:777-790`; `manifestUpdateProvider.ts:36-41` |
| Version messaging/release notes | Present | `updateReleaseNotes.ts:8-27`; `UpdateStatusButton.tsx:106-165` |
| Changelog surfacing | Present (zh/en only) | `desktopCommandHandlers.ts:452-467` |
| Feedback/bug reporting | Present | `desktopApplicationMenu.ts:348-352`; `App.tsx:45,1178` |
| Force update | Present | `forceUpdate.ts:22-58`; `forceUpdateGuard.ts:13,73,163` |
| i18n coverage of surfaces | Partial (ключи 100%, ru не покрывает webview/changelog) | i18n-скрипт; `codingPlanEmbeddedWebview.ts:80-81`; `desktopCommandHandlers.ts:459` |

### 8.7. Not checked list

- Реальный рендер Settings/Store/Onboarding и визуальное соответствие DESIGN.md.
- Реальные OAuth-потоки Z.ai/BigModel, `oauthCredentialRepo`, refresh/logout в runtime.
- Реальный `/event/report`, `client/configs`, ARMS, OTLP; consent/opt-out отсутствует в коде, но серверные политики и исторические данные не проверялись.
- Реальный официальный CDN (`cdn-zcode.z.ai`), sha256 zip, install/update из сети.
- Платёжный webview `/coding-plan`, Stripe/PayPal/Alipay, enterprise order API.
- Desktop E2E, mobile relay, SSH/WSL/Docker, Windows/Linux.
- Покрытие тестами фактическим исполнением: запуск vitest/typecheck/lint не выполнялся.
- Внешний publishing-репозиторий и его модерация/verification.

### 8.8. Заявление о записи

Записан **только** этот partial-файл: `docs/research/partials/2026-11-11-zcode-15-product-onboarding-marketplace.md`. Иных файлов не создавалось и не изменялось; коммиты не выполнялись.
