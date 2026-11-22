# Remote component update UX

| 字段     | 值                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施                                                                                                                                                      |
| 日期     | 2026-11-20                                                                                                                                                  |
| 来源     | Remote update UX review: misleading "restart remote server" copy                                                                                            |
| 适用范围 | `packages/ui/src/i18n/locales/**`、`packages/ui/src/settings/**`、`packages/ui/src/remote-connection/**`、`packages/ui/src/lib/sourceServerUpdateAction.ts` |
| 主要对象 | `SourceServerUpdateActivity`、`DeviceUpdateBanner`、`RemoteConnectionForceUpdatePanel`、`runSourceServerUpdate`                                             |

## 1. Проблема

Пользователь видит в обновлении удалённого компонента тексты «Перезапуск удалённого
сервера» и «Обновление удалённого компонента…». Формулировки «сервер» и «устройство»
читаются как перезагрузка машины, хотя обновляется только служебный компонент ZCode.

Подтверждённые факты:

- Обновление останавливает только Core и запускает новую версию:
  `packages/zcode-server-cli/src/supervisor/supervisor.ts:278-304`.
- Handoff обновления останавливает и запускает только daemon/Supervisor ZCode:
  `packages/zcode-server-cli/src/runtime/updateHandoff.ts:185-204`.
- В `packages/zcode-server-cli/src` и `packages/desktop/src` нет вызовов
  `reboot`, `poweroff`, `shutdown -r` или `systemctl reboot` (repo-wide поиск по
  исходникам без generated/bundled артефактов).
- При `runningTaskCount > 0` обычное обновление блокируется структурированной ошибкой
  `source-server-update-running-tasks`; `force` останавливает Core и прерывает задачи:
  `packages/zcode-server-cli/src/supervisor/supervisor.ts:281-287`,
  `:532-540`.
- После успешного обновления Desktop инвалидирует старое соединение и заново
  подключается к Source:
  `packages/desktop/src/host/source-server-connection/update.ts:79-95`,
  `packages/desktop/src/host/source-server-connection/recovery.ts:128-147`.

Старые тексты:

- `remote.phaseSub.restarting` = «Перезапуск удалённого сервера» (`ru-RU.json:5922`).
- `settings.source.updateInProgress` = «Обновление удаленного компонента…»
  (`ru-RU.json:1351`).
- `remote.connectingSubtitleUpdating` = «Обновление удалённого сервера»
  (`ru-RU.json:5917`).

## 2. Продуктовые правила

1. Обновляется и перезапускается только компонент/служба ZCode на удалённой машине.
   ОС, устройство и сервер как машина не перезагружаются.
2. Обновление не прерывает выполняющиеся задачи по умолчанию. При
   `source-server-update-running-tasks` UI сначала запрашивает обычное обновление с
   `force: false` и только после явного подтверждения пользователя повторяет запрос с
   `force: true` один раз.
3. Подтверждение force-обновления обязано явно сказать, что задачи будут прерваны,
   перезапускается только служба ZCode, а сессия переподключится автоматически.
4. После успешного обновления сессия переподключается автоматически; ручной повторный
   вход не требуется.
5. Идемпотентность: UI не создаёт новых автоматических повторов. В wizard повторный
   запуск блокируется `upgradeLoading`, в настройках — busy-ключом
   `update:<profileId>`. Один пользовательский жест приводит максимум к двум запросам:
   `force: false`, затем один `force: true` после подтверждения.
6. Единственный владелец решения о `force` — `runSourceServerUpdate`
   (`packages/ui/src/lib/sourceServerUpdateAction.ts`). Компоненты не выставляют
   `force` напрямую и не дублируют состояние обновления.
7. Владелец состояния обновления — Host/`SourceServerManagementService`; UI только
   читает snapshot и отображает `state === "updating"`, `updateAvailability` и
   `upgradeTarget`.

## 3. Состояния UI

| Состояние                            | Поверхность                                          | Поведение                                                                |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `available` / `required`             | `DeviceUpdateBanner`                                 | Кнопка обновления; текст не обещает перезагрузку машины                  |
| `updating`                           | `DeviceUpdateBanner`                                 | `settings.source.updateInProgress` + компактная строка `updateScopeNote` |
| `updating`                           | `SourceServerUpdateActivity` (`phase === "restart"`) | `remote.phaseSub.restarting` = перезапуск службы ZCode                   |
| `updating`                           | `remoteConnectionWizard` (`context.updating`)        | `remote.connectingSubtitleUpdating` = обновление компонента ZCode        |
| `source-server-update-running-tasks` | `RemoteConnectionForceUpdatePanel`, settings confirm | Список задач + предупреждение о прерывании и перезапуске службы ZCode    |
| Успех                                | Source connection manager                            | Автоматическое переподключение после update                              |

Порядок событий:

```text
user action
  → runSourceServerUpdate(force=false)
  → guard: source-server-update-running-tasks
  → confirm dialog (interrupt tasks, only ZCode service, auto reconnect)
  → runSourceServerUpdate(force=true)   // максимум один раз
  → Host snapshot state=updating
  → Core/daemon restart
  → connection invalidation → automatic reconnect → online
```

## 4. Тексты

Ключи не переименовываются. Все строки добавлены/изменены в `en-US.ts`,
`ru-RU.json`, `zh-CN.ts`.

| Ключ                                     | en-US                                                                                                                                                                                          | ru-RU                                                                                                                                                                                           | zh-CN                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `remote.phaseSub.restarting`             | Restarting the ZCode service                                                                                                                                                                   | Перезапуск службы ZCode                                                                                                                                                                         | 正在重启 ZCode 服务                                                                                       |
| `settings.source.updateInProgress`       | Updating the ZCode remote component…                                                                                                                                                           | Обновление удалённого компонента ZCode…                                                                                                                                                         | 正在更新 ZCode 远程组件…                                                                                  |
| `remote.connectingSubtitleUpdating`      | Updating the ZCode remote component…                                                                                                                                                           | Обновление удалённого компонента ZCode…                                                                                                                                                         | 正在更新 ZCode 远程组件…                                                                                  |
| `settings.source.updateScopeNote`        | Only the ZCode remote component is updated and restarted. Your OS and device are not rebooted.                                                                                                 | Обновляется и перезапускается только удалённый компонент ZCode. Операционная система и устройство не перезагружаются.                                                                           | 只更新并重启 ZCode 远程组件，操作系统和设备不会重启。                                                     |
| `settings.source.forceUpdateDescription` | A forced update interrupts tasks that are still running on this device and restarts only the ZCode service. The session reconnects automatically. Confirm that these tasks may be interrupted. | Принудительное обновление прервёт выполняющиеся задачи на этом устройстве и перезапустит только службу ZCode. Сессия переподключится автоматически. Подтвердите, что эти задачи можно прервать. | 强制更新会中断此设备上仍在运行的任务，并且只重启 ZCode 服务。会话会自动重新连接。请确认这些任务可以停止。 |
| `remote.runningTasksUnavailable`         | The device did not report its task list. A forced update interrupts running tasks and restarts only the ZCode service. The session reconnects automatically.                                   | Устройство не предоставило список задач. Принудительное обновление прервёт выполняющиеся задачи и перезапустит только службу ZCode. Сессия переподключится автоматически.                       | 设备未提供任务清单。强制更新会中断正在运行的任务，并且只重启 ZCode 服务。会话会自动重新连接。             |

Требования к формулировкам:

- Тексты restart/update не содержат «remote server», «удалённый сервер»,
  «远端服务» как объекта перезапуска.
- Тексты явно называют ZCode service/component.
- Предупреждение force-обновления содержит все три факта: прерывание задач,
  перезапуск только службы ZCode, автоматическое переподключение сессии.
- Строка scope note не добавляет новый визуальный уровень: используется тот же
  компактный `text-ui-xs opacity-80`, что и у `settings.source.versionDetails`.

## 5. Acceptance

1. `remote.phaseSub.restarting` в ru/en/zh означает перезапуск службы/компонента ZCode
   и не содержит слов «server»/«сервер»/«服务» как объекта перезапуска.
2. `SourceServerUpdateActivity` для лога с `phase: "restart"` показывает локализованный
   текст перезапуска службы ZCode в ru/en/zh.
3. `DeviceUpdateBanner` при `state === "updating"` показывает
   `settings.source.updateInProgress` и `settings.source.updateScopeNote`.
4. `remote.connectingSubtitleUpdating` в ru/en/zh говорит об обновлении удалённого
   компонента ZCode.
5. При ошибке `source-server-update-running-tasks` первый запрос уходит с
   `force: false`; confirm-текст предупреждает о прерывании задач, перезапуске только
   службы ZCode и автоматическом переподключении; отмена не отправляет `force: true`.
6. После одного подтверждения выполняется ровно один `force: true` запрос; новых
   автоматических повторов нет.
7. При отсутствии списка задач используется `remote.runningTasksUnavailable` с тем же
   предупреждением.
8. Ни один путь обновления не вызывает перезагрузку ОС/устройства.

## 6. Verification

- `packages/ui/test/remoteComponentUpdateUx.test.ts` проверяет точные строки шести ключей
  в ru/en/zh, отсутствие формулировок про перезапуск remote server/device, scope note,
  предупреждение force-обновления, маппинг phase `restart` в `SourceServerUpdateActivity`
  и отображение scope note в `DeviceUpdateBanner` при `state === "updating"`.
- `packages/ui/test/sourceServerUpdateAction.test.ts` дополнительно проверяет:
  `force: false` по умолчанию; `force: true` только после confirm; отсутствие
  автоматического повтора при повторной ошибке; отсутствие force-подтверждения для
  обычных ошибок; текст `getSourceServerForceUpdateDescription` со списком задач и с
  `remote.runningTasksUnavailable`.
- Фактически выполнено:
  `pnpm exec vitest run packages/ui/test/remoteComponentUpdateUx.test.ts
packages/ui/test/sourceServerUpdateAction.test.ts
packages/ui/test/sourceServerManagementPanel.test.ts
packages/ui/test/remoteConnectionPhases.test.ts
packages/ui/test/remoteConnectionInstallProgress.test.ts
packages/ui/test/intlProviderLocalePreference.test.ts` — 6 файлов, 141 тест, passed.
- `pnpm exec oxlint` по `remoteComponentUpdateUx.test.ts`, `sourceServerUpdateAction.test.ts`,
  `en-US.ts`, `zh-CN.ts`, `DeviceUpdateBanner.tsx` — 0 warnings, 0 errors.
- Playwright/E2E для этих текстов не существует; UI-проверка ограничена
  компонентными тестами. Ручная проверка: открыть удалённое устройство, запустить
  обновление при активной задаче и сверить баннер, прогресс и confirm-диалог в ru/en/zh.
