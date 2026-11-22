# Observation masking старых tool results

Статус: реализовано 2026-11-16 для provider-visible runtime history.

## Проблема

`microcompact` умел полностью заменять старые tool results строкой
`[Old tool result content cleared]`, но был opt-in и никем не включался. В длинных
ветках это оставляло в контексте десятки тысяч токенов старых Read/Bash/WebFetch
результатов, хотя модели обычно нужен только факт выполнения, цель и возможность
повторно прочитать источник.

## Продуктовое правило

1. Observation masking включён по умолчанию при включённой компакции. Явный
   `microcompact.enabled=false` остаётся выключателем; `features.compact=false`
   по-прежнему отключает всю компакцию.
2. Маскируются только старые группы tool results: последние
   `keepRecentToolResults` групп (по умолчанию 5) остаются нетронутыми.
3. Маска сохраняет полезные признаки вместо полного исчезновения:
   имя инструмента, цель (`path`/`pattern` для Read/Edit/Write/ApplyPatch/Grep/Glob),
   признак `status=error` и исходную длину в символах. Содержимое, команда Bash,
   URL и текст ошибки в маску не копируются.
4. Медиа (image/video/file) и ошибочные результаты по умолчанию не маскируются.
   `clearErrorResults=true` разрешает маскировать ошибки явно.
5. Маленькие результаты (меньше `minMaskChars`, по умолчанию 1 000 символов) не
   маскируются, но остаются членом группы: свежий маленький результат защищает
   старый крупный от преждевременной очистки.
6. Для обратной совместимости и диагностики доступен `maskStyle: "clear"` —
   прежняя строка `[Old tool result content cleared]`.
7. Маскируется только provider-visible runtime history. Durable transcript и UI
   сохраняют исходный tool result; повторное чтение файла/URL остаётся доступным.
8. Триггеры прежние: token pressure (порог microcompact) или idle > 60 минут.
   Минимальная экономия — 256 токенов; если маска не даёт экономии, изменение не
   применяется.

## Владелец состояния

- Чистая политика и формат маски: `apps/zcode-cli/packages/core/src/compact/microcompact.ts`.
- Единственный runtime-применитель: `runtime/methods/microcompact.ts` через
  `maybeLocalMicrocompactRuntimeEntries`.
- Tool input для цели берётся из уже существующего assistant tool call; второй
  реестр tool calls не создаётся.

## До / после

|                            | До                            | После                                                                                                          |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Старый Read 12 KB          | весь текст в provider history | `[Old tool observation masked: Read path=/src/x.ts chars=12000; re-run the tool if the full output is needed]` |
| Старый Bash                | весь вывод                    | `[Old tool observation masked: Bash chars=4200; ...]` без команды                                              |
| Media/error                | защищены                      | защищены                                                                                                       |
| Маленький свежий результат | мог не защищать старую группу | остаётся в группе и защищает                                                                                   |

## Приёмочные сценарии

| ID    | Сценарий                         | Ожидаемый результат                                                   |
| ----- | -------------------------------- | --------------------------------------------------------------------- |
| OM-01 | Token pressure, 2 группы, keep=1 | старая группа маскируется, свежая остаётся                            |
| OM-02 | Read с `file_path`               | маска содержит `Read path=...` и `chars=`, не содержит исходный текст |
| OM-03 | Bash/WebFetch                    | маска не повторяет команду/URL                                        |
| OM-04 | image/video/file                 | не маскируется                                                        |
| OM-05 | error result                     | по умолчанию не маскируется                                           |
| OM-06 | результат < 1000 символов        | не маскируется, но участвует в keep-группе                            |
| OM-07 | `maskStyle: "clear"`             | прежняя строка очистки                                                |
| OM-08 | `enabled: false`                 | политика не применяется                                               |
| OM-09 | Повторный запуск                 | уже замаскированный результат не маскируется повторно                 |

## Проверки

- `packages/core/tests/microcompact.test.ts` — 13 тестов, включая observation mask,
  clear strategy, малый результат, media/error.
- `packages/core/tests/runtime-output-token-continuation-compact.test.ts` — persistence
  и output-token continuation.
- `packages/core/tests/runtime-compact.test.ts` — runtime microcompact/manual compact.
