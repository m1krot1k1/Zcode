# Автоматический перехват отказанного пункта задачи нецензурированной моделью

Статус: спецификация принята 2026-11-23; реализация в работе.
Дата: 2026-11-23.

Спецификация обязательна для четырёх областей реализации: настройки и протокол Host,
runtime CLI, проекция чата и UI, проверки. Любое расхождение с ней считается дефектом
реализации, а не альтернативной трактовкой.

## Ревизия 2026-11-23: multi-provider

Пользователь уточнил форму настроек: раздел называется **«Uncensored провайдеры»** и
содержит несколько вручную добавленных провайдеров. У каждого провайдера свой API URL,
свой API Key и собственный список моделей с переключателями. Эта ревизия заменяет
single-provider поля `apiUrl`/`apiKey`/`models` во всех разделах ниже.

- `providers: [{ id, name, apiUrl, models: [{ id, enabled }] }]`; порядок провайдеров и
  моделей — порядок fallback.
- Ключ хранится per provider:
  `code-intelligence:<workspaceKey>:uncensored-api-key:<providerId>`.
- Статус UI: `providers: [{ id, name, apiUrl, apiKeyConfigured, models }]`.
- Запись UI: `providers: [{ id, name, apiUrl, apiKey?, models }]`; отсутствующий
  `apiKey` сохраняет ключ, `null` удаляет, непустая строка записывает.
- `uncensored/getConfig` возвращает
  `providers: [{ id, name, apiUrl, apiKey, models }]`.
- Перехват идёт по провайдерам в порядке настройки, внутри провайдера — по включённым
  моделям. При отказе/ошибке — следующая модель, затем следующий провайдер.
  `no-enabled-models` — если ни у одного провайдера нет включённых моделей.
- Удаление провайдера удаляет его ключ; пустой список провайдеров — полный сброс.
- В карточке под-запуска показываются провайдер, модель, статус и вывод.

## General chat refusal (2026-11-24)

- Attribution cascade: first `in_progress` todo, else first `pending`, else the **last user
  message** as item 0 (same 4000-char bound). A plain chat turn therefore gets a takeover
  even when no TodoWrite list exists.
- No extra classification model call: the decision uses the already received finish reason
  and the final assistant text.
- Exactly one attempt per enabled uncensored model; no retry of the same model and no loop.
  A successful main-model answer never calls an uncensored model.
- When every enabled model refuses or fails, the terminal `refused`/`error` status is
  persisted and shown; the turn is not restarted.

### Text refusal cascade (2026-11-24, revision 2)

Многие провайдеры отказывают текстом, а не finish reason: `finish_reason` остаётся `stop`, и
`rawFinishReason` пуст. Поэтому существует второй слой решения — подбор текстового отказа.

- Условия срабатывания: провайдер не сообщил отказ, finish reason — `stop`, в последнем сообщении
  assistant нет tool calls, длина текста до 4000 символов и текст не заканчивается вопросом.
- Решение принимает узкий набор шаблонов (`detectTextRefusal`), а не эвристика по смыслу:
  стем отказа должен быть дополнен глаголом обслуживания запроса (`не могу выполнить`,
  `не буду помогать`) либо, в начале фразы, разделителем, вводящим причину
  (`Не буду — это оскорбление`). Один стем без продолжения (`Я не буду менять конфигурацию`)
  отказом не считается.
- Покрытие языков: английский, русский, китайский. Русская форма отказа без глагола
  обслуживания (`Это оскорбление, я такое не произношу`) распознаётся отдельной формой отказа
  от произнесения.
- Слой не читает вывод инструментов, не срабатывает после tool call и не срабатывает на
  уточняющий вопрос. Пропуск слоя сохраняет обычное поведение хода; ложное срабатывание
  перенаправило бы нормальный ответ, поэтому шаблоны остаются высокоточными.
- Слой применяется к обеим сторонам: тем же набором определяется отказ самой нецензурированной
  модели при попытке takeover.
- Тот же слой применяется к обеим транспортным веткам takeover: и к mirror-вызову
  `generateWorkspaceText`, и к legacy raw HTTP. Текстовый отказ в raw-ответе даёт статус
  `refused`, а не `done`; иначе отказ резервной модели подменял бы успешный результат и
  финальный текст хода.

### Ревизия 2026-11-25: маркер отказа и сгенерированный код

- Протокольный маркер распознаётся только вне fenced/inline code. Маркер внутри
  сгенерированного кода — литерал, пример или тест, а не отказ: такой ответ возвращается
  выбранной моделью целиком и не запускает takeover.
- `stripRefusalMarker` удаляет токен только вне code-сегментов, поэтому код не теряет
  литерал маркера; ответ без маркера в прозе возвращается без изменений.
- Условия настоящего отказа не меняются: маркер в обычном тексте, finish reason
  `refusal`/`content-filter` и текстовые формы по-прежнему запускают takeover.

## Ревизия 2026-11-25: финальный текст хода

- Если ответ основной модели — отказ, а пункт обработан резервной моделью, последним
  видимым текстом хода становится результат резервной модели. Отказ основной модели
  сохраняется в истории и метаданных (`model.refusal`, durable-строка takeover), но не
  подменяет результат перехвата.
- Финальный текст пишет единственный владелец — гейт перехвата; второго пути записи нет.
  Подробные правила, сценарии и порядок событий — в разделах «Финальный текст хода» и
  «Порядок событий».
- `TurnComplete.response` и `TurnResult.response` в этом случае равны финальному тексту,
  чтобы клиентские фолбэки не дописывали отказ основной модели после ответа резервной.

## Ревизия 2026-11-27: опции вызова берутся из модели

- Причина: mirror-вызов жёстко ставил `reasoningLevel: "disabled"` и не задавал бюджет, а
  резолвер подставлял дефолтный `maxOutputTokens`. Host option map отдаёт в этом сочетании
  `reasoning_effort: "none"` при малом объявленном максимуме модели, и registry отвергал
  запрос `maxOutputTokens is outside the model option range` ещё до сети. Mirror-ветка не
  работала ни разу: оставался raw-fallback с задержкой около 50 секунд.
- Правило: оба значения берутся из `optionSpecs` самой модели — первый (самый дешёвый)
  `reasoningLevel` и `maxOutputTokens = min(16384, объявленный максимум)`. Зачение уходит и
  в `selection.options`, и в `maxOutputTokens` запроса, поэтому диапазон не нарушается.
- Если модель не удаётся собрать (нет factory, битые опции), поля опускаются и остаётся
  прежнее поведение — попытка, а не падение.

## Ревизия 2026-11-26: inline-код не отменяет детект отказа

- Причина: сигнал «в ответе есть работа» считал работой любое inline-упоминание в
  одинарных бэктиках. Отказ routinely цитирует имя хоста или заголовок
  (`_zcode-proof.azhur.online`, `WWW-Authenticate: Basic realm=…`), и детектор текстового
  отказа его пропускал — перехват не запускался, uncensored-модель не вызывалась.
- Правило: работой считается только fenced-блок (` ``` `) или путь к коду с
  известным расширением. Одинарные бэктики сами по себе детект не отменяют; граница кода
  для маркера отказа по-прежнему определяется маскированием code-сегментов.
- Точность сохраняется структурами отказа (отрицание + объект/действие, policy-формы,
  пивот) — одних бэктиков недостаточно ни чтобы признать отказ, ни чтобы его отменить.

## Ревизия 2026-11-26: восстановление конфига перехвата из реестра

- Remote Environment получает mirror-провайдеров и их ключи через provider provisioning,
  но файл `uncensored-settings.json` — нет. Гейт читал только стор и в remote-workspace
  всегда видел `no-enabled-models`: uncensored-модель не вызывалась, пользователь получал
  отказ основной модели без единого запроса к резервной.
- Если стор пуст, `getTakeoverConfig` восстанавливает провайдеров из реестровых зеркал
  (префикс `Uncensored · `): `providerId`, включённые и поддерживаемые модели, `apiUrl`
  из `baseUrl` (с добавлением `/chat/completions` при необходимости), `apiKey: null` —
  вызов идёт по `providerId`, секрет остаётся в реестре целевого Host.
- Непустой стор приоритетен и не переопределяется. Удаление всех провайдеров удаляет и
  зеркала, поэтому fallback ничего не воскрешает. Ошибка чтения реестра даёт пустой
  список и не блокирует интерфейс.

## Ревизия 2026-11-26: перенос настроек в remote Environment

- Настройки uncensored-провайдеров и их mirror создаются на локальном Host, а агент
  remote-workspace исполняется на удалённом Host и читает его реестр. Без переноса
  композер удалённого workspace не видит mirror-модель (пустой список у провайдера), а
  takeover получает `no-enabled-models`.
- Владелец состояния остаётся единственным — локальное хранилище. Renderer при
  монтировании workspace-слоя читает локальный `getTakeoverConfig` и, если состав
  провайдеров или их моделей отличается, пишет его в целевой Environment через его
  `updateConfig` — тот же путь, что и обычное сохранение: секрет уходит в credential
  store целевого Host, mirror обновляется там же.
- Сравнение по имени провайдера и списку моделей делает перенос идемпотентным:
  совпадающий Environment не перезаписывается на каждом монтировании.
- Ошибка переноса не блокирует интерфейс: локальные настройки остаются источником,
  повтор происходит при следующей активации workspace.
- Перенос выполняется только для remote-workspace; локальный Environment уже владеет
  настройками, поэтому лишних записей нет.

## Ревизия 2026-11-26: вызов резервной модели без deliberation

- Причина: у thinking-моделей (суффикс `:thinking`) серверный reasoning расходует тот же
  бюджет вывода, что и ответ. При `max_tokens: 4096` reasoning занимает все токены,
  провайдер возвращает `finish_reason: "length"` и пустой `message.content`; попытка
  падает в `error`/`empty-content`, хотя модель фактически рассуждала, а не отказывала.
- Правило: запрос перехвата не должен включать серверное обдумывание. Mirror-ветка
  отправляет `reasoning_effort: "none"`; в legacy raw-ветке с wire-идентификатора модели
  снимается суффикс `:thinking`. Атрибуция (`providerName`, `modelId` в карточке и
  durable-строке) сохраняет исходный id из конфигурации.
- Снимается только точный суффикс `:thinking` (регистронезависимо, в конце id); теги вида
  `llama3:8b` не затрагиваются.
- Бюджет: raw `max_tokens` поднимается до `16384` как запас для провайдеров, которые
  обдумывают запрос несмотря на суффикс; mirror-ветка перестаёт жёстко ограничивать вывод
  `4096` и использует объявленный моделью `maxOutputTokens` (иначе — общий дефолт
  резолвера), чтобы длинный ответ thinking-модели не обрезался.
- Reasoning-текст не подставляется вместо ответа: пустой `content` остаётся `error`, а
  финальный текст — явная ошибка по правилам раздела «Финальный текст хода».
- Таймаут 60 000 мс и «одна попытка на модель» не меняются.

## Ревизия 2026-11-24: mirror-провайдер и точечный список

- CLI-подхват использует `providerId` mirror-провайдера из обычного реестра и вызывает
  `generateWorkspaceText` — ту же рабочую конфигурацию провайдера/модели, что и чат.
  Raw POST по `apiUrl` остаётся только legacy-fallback для конфигов без `providerId`
  (например, старый Host без mirror): базовый URL вида `/api/v1` давал 404.
- Если TodoWrite пуст, последнее user-сообщение разбивается на нумерованные/маркированные
  пункты. В uncensored уходит пункт с максимальным пересечением токенов с текстом отказа;
  при общем отказе — первый пункт. Остальные пункты остаются основной модели.
- `uncensored/getConfig` добавляет к провайдеру nullable `providerId`; URL/ключ остаются
  для создания mirror-провайдера и не используются takeover'ом, если mirror готов.
- Acceptance: multi-item prompt без TodoWrite → в uncensored уходит только отказанный
  пункт; при наличии mirror-провайдера raw HTTP не вызывается.

## Проблема

Основная модель чата ведёт задачу по списку `TodoWrite`. На одном пункте провайдер может
вернуть отказ на уровне finish reason (`refusal`, `content-filter`; `content_filter`
покрывается нормализацией). Сейчас runtime сохраняет отказ как обычный текстовый ответ и
завершает turn: пользователь получает отказ по одному пункту и теряет остальные, хотя
рядом может быть включена нецензурированная модель, способная выполнить именно этот
пункт.

## Продуктовое правило

1. Основная модель остаётся владельцем задачи и единственным писателем todo-списка.
2. Если основная модель отказалась ровно от одного пункта задачи, только этот пункт
   вместе с минимальным ограниченным контекстом отправляется первой включённой
   нецензурированной модели.
3. При отказе или ошибке этой модели попытка повторяется на следующей включённой модели в
   порядке настройки. Ретраев одной и той же модели нет.
4. Если не включено ни одной модели, фиксируется явный статус `no-enabled-models` без
   единого HTTP-запроса.
5. Результат виден в чате отдельным агентом/подпрогоном с моделью, статусом и полным
   выводом.
6. После терминального события перехвата основная модель продолжает оставшиеся пункты.
   Уже завершённые пункты не повторяются. Исключение — ход без оставшихся пунктов:
   отказ по всему пользовательскому сообщению (plain chat), отказ по последнему
   `pending`/`in_progress` пункту todo и повторный отказ от уже обработанного пункта
   завершают ход финальным текстом из результата резервной модели (раздел «Финальный
   текст хода»).
7. При отсутствии отказа поведение и поток событий не меняются побайтово.

## Не входит

- Изменение Embedding: `embedding-settings.json`, `embeddingSettings.ts`, контракты,
  ключи и API эмбеддингов не трогаются.
- Изменение поведения при отсутствии отказа: ни новых событий, ни новых записей, ни
  изменённых payload.
- Новые провайдеры, SDK или зависимости; используется обычный `fetch` и
  OpenAI-совместимый chat-completions endpoint.
- Передача всей задачи, полной истории, системного промпта или полного todo-списка во
  вспомогательную модель.
- Повторное выполнение уже завершённых пунктов и повторный перехват одного и того же
  пункта.
- Перехват внутри `querySource !== "main_turn"` (subagent, compact, title, sidecar):
  такие шаги не запускают takeover и не порождают `model.refusal`.
- Изменение версии корневого `package.json` в рамках фичи.

## Владельцы и данные

| Слой                 | Владелец                                                                                                                                                                | Ответственность                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Хранилище настроек   | новый `packages/services/src/code-intelligence/uncensoredSettings.ts`                                                                                                   | `uncensored-settings.json` рядом с индексом, порядок моделей, флаг ключа                                   |
| Секрет               | `ICredentialService` (Host)                                                                                                                                             | ключ `code-intelligence:<workspaceKey>:uncensored-api-key`                                                 |
| Host-обработчик      | `packages/services/src/zcode-agent/zcodeAgentServiceSessionMethods.ts` (семейство)                                                                                      | строгий reverse-RPC `uncensored/getConfig`, без логирования ключа                                          |
| Порт CLI             | новый `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/uncensored-config.ts` (по образцу `createProviderRuntimeHeadersPort`, `provider-runtime-headers.ts:20-107`) | один запрос конфигурации на попытку перехвата, таймаут, без ретраев                                        |
| Runtime              | `apps/zcode-cli/packages/core/src/runtime/methods/turn-stop.ts` (`finishModelStepWithoutToolCalls`) и `uncensored-takeover-gate.ts`                                     | детект отказа, контекст, попытки, события, продолжение и единственный владелец финального assistant-текста |
| Стор идемпотентности | новый `UncensoredTakeoverStore` в CLI session store (владелец `SessionStorePort`, тот же модуль, что todo)                                                              | `begin/complete`, дедупликация по ключу                                                                    |
| Проекция чата        | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection-subagents.ts`                                                                               | перенос нового поля `takeover` в строку `subagent`                                                         |
| UI настроек          | `packages/ui/src/settings/model-provider-section/*` и новый `UncensoredModelSettings`                                                                                   | форма, сохранение, статусы                                                                                 |
| UI чата              | новый компонент карточки takeover                                                                                                                                       | отображение пункта, модели, статуса, вывода                                                                |

`workspaceKey` — тот же, что у code intelligence:
`identity = workspaceIdentity?.trim() || workspacePath`,
`workspaceKey = sha256(identity).hex.slice(0, 32)` (`codeIntelligenceService.ts:117-124`).
Новый модуль повторяет это вычисление и не импортирует приватные функции эмбеддингов.

## Хранилище настроек Host

- Файл: `<indexRootDir>/uncensored-settings.json`, где `indexRootDir` — то же значение,
  что у сервиса code intelligence (`codeIntelligenceService.ts:78`). Формат — плоский
  JSON-объект `строка -> строка`, как в `embeddingSettings.ts:44-91`.
- Ключи записей: `uncensored:<workspaceKey>:apiUrl`, `uncensored:<workspaceKey>:models`,
  `uncensored:<workspaceKey>:apiKeyConfigured`.
- `models` хранится как JSON-массив `[{"id":"...","enabled":true}]` в порядке fallback.
- Чтение терпимо к битому файлу: невалидный JSON даёт настройки по умолчанию, а не исключение.
- Запись атомарна: полный снимок workspace-ключа сериализуется, пишется во временный файл
  в том же каталоге и заменяет `uncensored-settings.json` через `rename`; частично
  записанный файл не наблюдаем. Это осознанное отличие от `embeddingSettings.ts:59-62`,
  где используется прямой `writeFile` без temp+rename.
- Секрет в файл не пишется никогда. `apiKeyConfigured` — строка `"true"`/`"false"`,
  присутствует всегда, чтобы «неизвестно» не смешивалось с «ключа нет». Отсутствующий
  файл или битый JSON дают `apiUrl: null`, `apiKeyConfigured: false`, `models: []`.
- `embedding-settings.json` и `readEmbeddingSettings`/`writeEmbeddingSettings` не
  изменяются.

## Контракт настроек

Host-facing статус (то, что видит UI и что отдаётся CLI). Новые типы, вводимые этой
фичей:

```ts
type UncensoredModelEntry = { id: string; enabled: boolean };
type UncensoredSettingsStatus = {
  apiUrl: string | null;
  apiKeyConfigured: boolean;
  models: UncensoredModelEntry[];
};
type UncensoredSettingsWrite = {
  apiUrl: string | null;
  apiKey?: string | null; // отсутствует = сохранить, null = удалить, строка = записать
  models: UncensoredModelEntry[];
};
```

Значения по умолчанию: `apiUrl: null` (не пустая строка), `apiKeyConfigured: false`,
`models: []`. `apiKey` write-only: статус его никогда не возвращает и не читает для
отображения; наружу отдаётся только boolean `apiKeyConfigured`, как в Embedding
(`embeddingSettings.ts:120-122`).

Правила валидации записи:

- `apiUrl`: абсолютный URL, схема только `http` или `https`, обязательный host, без
  userinfo, без query, без fragment, pathname непустой и не `/`. Значение используется
  как есть: `/v1` и `/chat/completions` не дописываются.
- `apiUrl: null` — полный сброс workspace-конфигурации: URL, список моделей и секрет
  удаляются, `apiKeyConfigured` становится `false`.
- `models`: не более 50 записей; `id` после `trim()` непустой и уникальный (регистр
  учитывается); пустой или дублирующийся `id` — ошибка валидации всей записи, частичного
  сохранения нет.
- `apiKey`: пустая строка трактуется как «сохранить текущий»; `null` удаляет секрет;
  непустая строка записывается в `ICredentialService`.
- Статус никогда не содержит сам ключ и не читает его для отображения.
- Сохранение настроек не делает сетевых вызовов.
- Список моделей редактируется вручную; endpoint автоподбора моделей у провайдера не
  вызывается. Embedding для сравнения принимает единственную модель текстовым полем
  (`EmbeddingProviderSettings.tsx:500-511`), а метода перечисления моделей в контракте
  code intelligence нет (`packages/services/src/code-intelligence/contract.ts`).

## Протокол `uncensored/getConfig`

Настройки и ключ остаются Host-owned. CLI получает их строгим reverse-RPC вызовом,
построенным по образцу `providerRuntimeHeadersPort`
(`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts:20-107`)
и Host-обработчика того же семейства
(`packages/services/src/zcode-agent/zcodeAgentServiceSessionMethods.ts:238-330`).

Запрос (strict):

```ts
{ workspacePath: string; workspaceIdentity?: string }
```

Ответ (strict):

```ts
{
  apiUrl: string | null;
  apiKey: string | null;
  models: {
    id: string;
    enabled: boolean;
  }
  [];
}
```

- Имя метода — ровно `uncensored/getConfig`.
- Таймаут клиентского запроса — 30 000 мс; отдельного уведомления об отмене нет, потому
  что обработчик не держит очередь и не ждёт внешний IO, кроме чтения credential store.
- Ошибка транспорта, таймаут или несоответствие схеме завершают перехват статусом
  `error` без HTTP-запроса к модели. Это не `no-enabled-models`.
- Ключ передаётся только в ответе по существующему доверенному stdio-каналу, не пишется
  в env, файлы, события, строки таблицы или логи.
- Новый порт в bootstrap называется `UncensoredConfigPort` (единственный метод
  `getConfig(workspace)`), инжектится в core и не создаёт второго источника настроек.
- Тот же Host-модуль обслуживает UI-форму; UI не вызывает `uncensored/getConfig` и не
  получает секрет. Конкретные имена renderer→Host методов задаются по образцу соседних
  настроек в семействе `packages/services/src/code-intelligence/` +
  `packages/ui/src/hooks/useServices.tsx` и фиксируются контрактным тестом.

## Определение отказа

Отказ определяется только по finish level и только для `querySource === "main_turn"`.

Нормализация: взять `finishReason` и `rawFinishReason`, привести к нижнему регистру,
обрезать пробелы, заменить `_` на `-`. Нормативный набор отказа — `{ "refusal",
"content-filter" }`: он подтверждён `EMPTY_COMPLETION_RETRY_EXCLUSIONS`
(`apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts:435-440`), где
`content_filter` нормализуется в `content-filter`. Сырые значения `safety` и `blocked`
не подтверждены ни одним адаптером и вынесены в бакет «не проверено по адаптерам»: они
не входят в нормативный набор, пока тест адаптера не зафиксирует их emission;
добавление такого значения — аддитивное расширение набора вместе с тестом. Любое
другое значение, включая `stop`, `tool-calls`, `length`, `other`, `unknown` и пустую
строку, отказом не является. Уровень провайдера опирается только на finish reason: слова вроде
«I can't» или «sorry» сами по себе отказом не считаются. Отдельный слой текстового отказа
(см. «Text refusal cascade») работает поверх него и имеет собственные, узкие условия.

Источники значения:

- `RuntimeModelTextResult.finishReason`
  (`apps/zcode-cli/packages/core/src/runtime/types.ts:1009-1017`).
- `rawFinishReason` из `result.providerMetadata.rawFinishReason`, читается существующим
  `readRawFinishReason`
  (`apps/zcode-cli/packages/core/src/runtime/helpers/model-errors.ts:10-16`).
- Adapter сохраняет сырое значение как `providerMetadata.rawFinishReason`
  (`apps/zcode-cli/packages/adapters/src/model/runner-normalization.ts:289-306`, ключ —
  строка 303); событие `finish` несёт `finishReason` и `providerMetadata`
  (`apps/zcode-cli/packages/contracts/src/model/index.ts:693-698`), runtime не должен
  терять это значение.

Требование к внутреннему типу: в `RuntimeModelTextResult` добавляется новое
необязательное поле `rawFinishReason?: string`, заполняемое из `providerMetadata`.
Публичное событие `ModelStreamEvent` не меняется.

Условия запуска перехвата — одновременно все:

1. в шаге нет исполняемых tool calls;
2. нормализованный finish reason или raw входит во множество отказа;
3. пункт атрибутирован по правилу ниже;
4. `querySource === "main_turn"`.

Не запускают перехват: уточняющий вопрос (обычный `stop` с текстом), ошибка инструмента,
`stop` без отказа, шаг с tool calls, а также отказ без атрибутируемого пункта. В этих
случаях не создаётся ни `model.refusal`, ни строка takeover, и поведение остаётся
прежним.

Существующая локальная константа `EMPTY_COMPLETION_RETRY_EXCLUSIONS`
(`apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts:435-440`, не
экспортируется) — источник подтверждённого набора «отказ не ретраится как пустой
ответ». Детектор объявляет тот же набор в своём модуле и покрывает его регрессионным
тестом; текстовые эвристики по содержанию ответа запрещены.

## Атрибуция пункта

`TodoItem` не имеет id и индекса: схема содержит только `content`, `status`, `priority`
(`apps/zcode-cli/packages/contracts/src/tools/todo.ts:26-32`); единственный порядковый
номер — позиция в массиве.

- Читается текущий todo-список сессии на момент отказа.
- Кандидат: первый пункт со статусом `in_progress`; если такого нет — первый пункт со
  статусом `pending`.
- `itemIndex` — 0-based позиция кандидата в массиве.
- `itemText` — `content` кандидата дословно, но не длиннее 4 000 символов; при
  превышении обрезается и завершается символом `…`. Поле остаётся строкой без
  дополнительных флагов.
- `taskId` — идентификатор сессии CLI (`sessionId`), тот же, что используется в событиях.
- Если список пуст или все пункты `completed`, перехват не запускается.

Движок никогда не пишет todo сам: единственный писатель остаётся `TodoWrite`
(`todoWriteHandler` — `apps/zcode-cli/packages/core/src/tool/handlers/todo.ts:47-72` →
`SessionStorePort.updateTodos`; запись —
`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/todos.ts:24-52`;
регистрация инструмента — `todoWriteToolEntry`, `todo.ts:131-192`).

## Событие `model.refusal`

Новое durable-событие сессии:

- в `packages/shared/src/zcode-protocol/schema-events.ts` добавить `"model.refusal"` в
  `zcodeSessionEventTypeSchema` (текущий список — строки 99-128) и запись
  `zcodeSessionEventEnvelopeFor("model.refusal", zcodeModelRefusalEventPayloadSchema)` в
  перечень событий (рядом с `"model.streaming"`, строка 493);
  `zcodeModelRefusalEventPayloadSchema` — новая схема этой фичи;
- payload строгий, ровно четыре поля:

```ts
{
  taskId: string;
  itemIndex: number /* int >= 0 */;
  itemText: string /* 1..4000 */;
  reason: string;
}
```

- `reason` — нормализованное значение из множества отказа.
- `packages/shared/src/zcode-protocol/index.ts` экспортирует тип и схему события.
- В CLI-контрактах (`apps/zcode-cli/packages/contracts/src/events/session/base.ts:118-120`)
  добавляется новый член `ModelRefusal: "model_refusal"` рядом с `SubagentSpawned` и
  `SubagentStopped`.
- Маппинг внутреннего события в `model.refusal` без потери полей добавляется в
  `session-mapper.ts:293-311` (`mapSessionEvent`) и в существующие `mapSessionEventType`
  (`session-mapper-projection.ts:657-715`) и `mapSessionEventPayload`
  (`session-mapper.ts:370-403`): без явных веток неизвестный тип падает в
  `session.updated` (там же, строки 712-713).
- Событие durable: сначала запись в журнал, затем emit — как у существующих
  `appendEvent`.
- Событие создаётся один раз на отказанный пункт, до попыток HTTP.

## Минимальный контекст и запрос

Вход вспомогательной модели состоит ровно из двух сообщений.

System (фиксированная короткая строка, константа в коде):

```text
You complete exactly one task item. Produce the result directly. Do not ask questions.
```

User (шаблон, бюджет считается по этой строке целиком):

```text
Task item (index <itemIndex>):
<itemText>

Context fragments (most relevant first):
--- fragment 1: <toolName> <path or summary> ---
<text>
...
```

Бюджет и отбор:

- жёсткий лимит user-content — 12 000 символов, включая текст пункта, заголовки и
  разделители;
- текст пункта получает приоритет и занимает не более 4 000 символов;
- каждый фрагмент — не более 4 000 символов, фрагментов не более 3;
- источник фрагментов: только успешные результаты инструментов текущего turn
  (`querySource === "main_turn"`), у которых запись реестра имеет
  `metadata.readOnly === true` (пример поля — `todoReadToolEntry`,
  `apps/zcode-cli/packages/core/src/tool/handlers/todo.ts:74-93`, `readOnly` на строке 80);
- сначала берутся фрагменты, в input или output которых встречается путь, найденный в
  `itemText` (regex пути `[\w./-]+\.[A-Za-z0-9]+`); если таких меньше трёх,
  добираются самые свежие успешные read-only результаты;
- при нехватке бюджета фрагмент обрезается с `…`, лишние фрагменты отбрасываются;
- запрещено включать: полную историю, исходный system prompt, полный todo-список, тексты
  других пунктов, тексты ошибок инструментов.

Нормативное негативное утверждение теста —
`assertTakeoverRequestBodyExcludesFullPrompt(capturedRequests)`. Оно inspect-ит
JSON-тела запросов, перехваченные transport-fake (fake `fetch`), и проверяет: (а) у
запроса перехвата ровно два `messages` с ролями `system` и `user`; (б) в теле
отсутствуют sentinel-строки исходного system prompt, полной истории turn, полного
todo-списка и текстов других пунктов; (в) `user.content` содержит `itemText` и
укладывается в 12 000 символов; (г) ни один другой захваченный запрос перехвата не
содержит этих sentinel-строк. Проверка смотрит на captured request body, а не на
prompt, собранный в памяти.

Запрос:

```http
POST <apiUrl>
Authorization: Bearer <apiKey>   # только если ключ непустой
Content-Type: application/json
```

```json
{
  "model": "<id без суффикса :thinking>",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 16384,
  "stream": false
}
```

- `redirect: "error"`: ключ не должен уйти на другой host по редиректу.
- Таймаут одного запроса — 60 000 мс через `AbortSignal`.
- Ровно одна попытка на модель; ретраев, повторов таймаута и повторных запросов нет.
- Разбираются только `choices[0].message.content` (строка) и `choices[0].finish_reason`;
  наличие непустого `reasoning` фиксируется как факт, но не подменяет `content`.
- Пустой `content` при успешном HTTP — статус `error` этой попытки (`empty-content`), в том
  числе когда бюджет вывода израсходован reasoning-ом (`finish_reason: "length"`).
- Тело ответа провайдера не попадает в события, строки и логи; фиксируются только
  HTTP-статус и категория.

## Маршрутизация и fallback

Порядок — порядок массива `models` в настройках, учитываются только `enabled: true`.

| Условие попытки                                                       | Статус попытки      | Действие                         |
| --------------------------------------------------------------------- | ------------------- | -------------------------------- |
| HTTP не-2xx, сетевая ошибка, таймаут, невалидный JSON, пустой content | `error`             | следующая включённая модель      |
| 2xx, `finish_reason` нормализуется в множество отказа                 | `refused`           | следующая включённая модель      |
| 2xx, `finish_reason` обычный, content — текстовый отказ               | `refused`           | следующая включённая модель      |
| 2xx, `finish_reason` обычный, content непустой                        | `done`              | стоп, терминальный статус `done` |
| включённых моделей нет                                                | `no-enabled-models` | стоп, 0 HTTP-вызовов             |

- Если все попытки неуспешны, терминальный статус равен статусу последней попытки
  (`refused` или `error`).
- Новый терминальный статус `no-enabled-models` не делает ни одного HTTP-запроса, но
  создаёт `model.refusal` и терминальную строку takeover с `modelId: null` и
  `output: ""`.
- Модели с `enabled: false` не вызываются и не влияют на порядок.
- Ошибка `uncensored/getConfig` даёт статус `error`, `modelId: null`, 0 HTTP-вызовов.

## Идемпотентность

Новый порт `UncensoredTakeoverStore` принадлежит CLI session store:

```ts
begin(input: { sessionId: string; taskId: string; itemIndex: number; itemText: string }):
  Promise<{ kind: "started"; agentId: string } | { kind: "duplicate"; agentId: string }>;
complete(input: { sessionId: string; agentId: string; status: ...; modelId: string | null; output: string; reason?: string }):
  Promise<void>;
```

- Ключ: `sessionId` + нормализованный `itemText` (`trim()`, последовательности пробелов
  схлопнуты в один пробел). `itemIndex` в ключ не входит: позиция может сдвинуться, текст
  пункта — нет.
- `agentId` детерминирован: `uncensored-takeover:<taskId>:<itemIndex>:<sha256(key).slice(0,16)>`.
- `duplicate` означает: HTTP не вызывается, второе событие `model.refusal` не создаётся,
  используется существующая строка/агент.
- Запись durable в каталоге сессии, атомарная замена файла; при resume терминальная
  запись отменяет повторный запуск.
- Требуемый тест: два вызова `begin` с одинаковым ключом дают ровно один HTTP-вызов.

## Встраивание в turn loop и продолжение

Точка входа — `finishModelStepWithoutToolCalls`
(`apps/zcode-cli/packages/core/src/runtime/methods/turn-stop.ts:177-282`), вызываемая из
`turn-model-step.ts:783-790` при отсутствии tool calls. Гейт перехвата размещается после
персиста assistant-сообщения (`turn-stop.ts:191-195`) и после раннего выхода
`automationCreateLimitReached` (`turn-stop.ts:196-214`), но до auto-repair гейта
(`turn-stop.ts:215-239`). `querySource` уже вычисляется в `turn-model-step.ts:135` и
попадает в `ModelComplete` (`turn-model-step.ts:673`); гейт обязан использовать то же
значение, а не повторно выводить его из текста.

Порядок внутри гейта:

1. Проверить условия раздела «Определение отказа»; иначе вернуть `unhandled`.
2. Прочитать todo, атрибутировать пункт; иначе `unhandled`.
3. Вычислить `wholeUserMessage`: todo-список пуст, а пункт совпадает со всем текущим
   user-сообщением после нормализации и обрезки. Для todo-пункта вычислить
   `hasRemainingTodoWork`: есть ли другой пункт в статусе `pending`/`in_progress`.
4. Если для ключа уже есть терминальный результат (кэш или durable):
   - результат получен в этом же ходе — записать финальный текст из него и вернуть
     `finish` (duplicate);
   - иначе добавить synthetic reminder и вернуть `continue` (duplicate без событий и
     HTTP).
5. Записать и отправить `model.refusal`.
6. Вызвать `UncensoredTakeoverStore.begin`; при `duplicate` перейти к шагу 4.
7. Отправить `SubagentSpawned` со статусом `running`.
8. Получить конфигурацию через `UncensoredConfigPort`; выполнить попытки по порядку.
9. Отправить `SubagentStopped` с терминальным статусом и полным выводом; вызвать
   `complete`.
10. Если ход отменён — вернуть `continue` (существующая обработка abort).
11. Если `wholeUserMessage` или у todo-пункта нет других `pending`/`in_progress` пунктов —
    записать финальный assistant-текст и вернуть `finish`.
12. Иначе (остаются другие пункты) добавить синтетическую запись запроса с `role: "user"`
    (system-reminder) и вернуть `continue`, чтобы `runRegularTurnLoop` (`turn-loop.ts:111`)
    запланировал следующий model step.

Синтетическая запись (английский текст, константа):

```text
[uncensored-takeover] Task item <itemIndex> was handled by a fallback model.
Status: <status>. Model: <modelId or none>.
Output:
<output>

Do not repeat this item. Mark it completed with TodoWrite, then continue with the remaining items.
If no items remain, reply with a short final summary.
```

- Механизм вставки — существующие `systemReminderAttachmentEntry`
  (`agent/message-history.ts:358`) / `commitTurnRequestEntries`
  (`runtime/methods/turn-output-token-continuation.ts:106`); пример использования —
  auto-repair в `turn-stop.ts:233-239`.
- Основная модель остаётся единственным писателем todo и сама помечает пункт
  `completed`; движок статус не меняет.
- Если другие `pending`/`in_progress` пункты остаются, следующий model step запрашивается
  и после их выполнения просит короткое резюме.
- В ветке продолжения `"continue"` сохраняет тот же active turn и счётчик model steps.
- Если других пунктов нет, следующий model step не запрашивается: финальный текст
  пишется сразу, ход завершается (`finish`); статус пункта движок не меняет.

## Финальный текст хода

Продуктовое правило: если шаг основной модели завершился отказом, а пункт передан
резервной модели, последним видимым assistant-текстом хода является результат резервной
модели. Отказ основной модели остаётся отдельным assistant-сообщением в истории и в
метаданных (`model.refusal` и durable-строка takeover); он не удаляется и не
перезаписывается, но и не становится финальным текстом вместо результата перехвата.

Владелец решения — `runUncensoredTakeoverGate`; второго пути записи финального текста
нет. Гейт возвращает один из результатов: `unhandled` (не перехват), `continue`
(следующий model step) или `finish` с `finalText` и `assistantMessageId` (финальный
текст уже записан, ход завершается).

Выбор текста:

- `done` с непустым `output` — `output` дословно (маркер отказа уже удалён
  оркестратором);
- `refused`, `error`, `no-enabled-models` или пустой `output` — явный текст ошибки, а не
  отказ основной модели: `Fallback model <provider>/<model> did not produce an answer
(status: <status>[: <reason>]).`, а при отсутствии модели —
  `No fallback model produced an answer (status: <status>[: <reason>]).`.

Запись финального текста:

- один синтетический assistant-message на ход: `text` part, `completed`, `finish: "stop"`;
- тот же текст отправляется существующими `ModelStreaming` событиями
  `text_start`/`text_delta`/`text_end`, поэтому live-UI и cold replay показывают один и тот
  же последний текст;
- `step-finish`, usage и cost не пишутся: это не model step, а синтетический ответ.
  `persistCompletedAssistantStep` здесь не переиспользуется: он коммитит
  `state.modelResponse` (отказ) и диагностику основного шага, а не результат резервной
  модели;
- `TurnComplete.response` и `TurnResult.response` равны финальному тексту (результату
  резервной модели), потому что TUI и legacy web-проекция используют их как
  authoritative-фолбэк видимого ответа; в `turn-stop.ts` перед завершением хода
  `state.modelResponse` заменяется на этот текст. Отказ основного шага остаётся в истории
  отдельным assistant-сообщением;
- повторной записи и повторных takeover-событий при `duplicate` нет.

Атрибуция:

- assistant-message и запись в turn request получают `providerId`/`modelId` из
  `TakeoverTerminal`, то есть модель, выдавшую результат, а не основную модель;
- если терминальное состояние не содержит модели (`no-enabled-models`, ошибка
  конфигурации), сообщение пишется без `providerId`/`modelId`; подставлять основную
  модель запрещено. Это выражается существующими необязательными полями
  `AssistantMessageInfo`, без смены провайдеров и моделей.

Ветки:

- plain chat: todo-список пуст, атрибутированный пункт совпадает со всем текущим
  user-сообщением после `normalizeItemText` и `truncateItemText` — финальный текст
  пишется сразу, следующий model step не запрашивается;
- duplicate: пункт уже обработан в этом же ходе (system-reminder уже добавлен), а
  основная модель повторно отказалась от него — финальный текст берётся из сохранённого
  терминального результата; `model.refusal`, spawn/stop и HTTP не повторяются;
- todo: остаются другие `pending`/`in_progress` пункты, кроме обработанного — финальный
  текст не пишется, добавляется system-reminder и ход продолжается; если других пунктов
  нет — финальный текст пишется сразу, следующий model step не запрашивается. Статус
  пункта движок не меняет: todo остаётся единственной зоной записи основной модели.

Завершение финальным текстом не запускает auto-repair и Stop hooks этого шага: решение
об ответе уже принято. Ожидающие guide переводятся в обычный fallback
`guide.noToolBoundary`, active turn становится не steerable.

## Порядок событий

```text
ModelComplete(stopReason = отказ)          // существующее событие шага
  -> model.refusal                          // durable, один раз на пункт
  -> SubagentSpawned(takeover.status=running, agentId детерминирован)
  -> HTTP attempts (0..N, последовательно)
  -> SubagentStopped(takeover.status=done|refused|error|no-enabled-models, полный output)
  -> final assistant message + ModelStreaming(text_*)  // plain chat / duplicate
  -> TurnComplete                           // финальный текст уже виден

todo-ветка вместо final assistant message:
  -> synthetic system-reminder entry        // не событие, часть следующего запроса
  -> следующий ModelRequest
```

- Запись выполняется до emit там, где это уже делает существующий код (`appendEvent`).
- Между `model.refusal` и `SubagentSpawned` нет других событий.
- При `duplicate` шаги 3-7 не повторяются: ни `model.refusal`, ни новые spawn/stop.
  Вместо них один раз пишется финальный assistant-текст из сохранённого результата и ход
  завершается; повторный отказ основной модели остаётся в истории, но не становится
  последним текстом.
- При отсутствии отказа порядок и состав событий не меняются.

## Chat sub-run и проекция

Используются существующие durable-события `SubagentSpawned`/`SubagentStopped`
(внутренние имена `subagent_spawned`/`subagent_stopped`,
`apps/zcode-cli/packages/contracts/src/events/session/base.ts:118-120`) с
`agentType: "uncensored-takeover"` (внутреннее поле события; проекция кладёт его в
`subagentRow.subagentType`, `product-projection-subagents.ts:294`), без
`parentToolCallId` и со стабильным `agentId`.

В payload CLI-события subagent и в `subagentRowSchema`
(`packages/shared/src/zcode-protocol-v4/rows.ts:269-299`) добавляется новое
необязательное поле:

```ts
takeover?: {
  taskId: string;
  itemIndex: number;
  itemText: string;
  modelId: string | null;
  status: "running" | "done" | "refused" | "error" | "no-enabled-models";
  output: string;
  reason?: string;
};
```

- `output` — полный ответ модели без усечения проекцией; схема допускает до 64 000
  символов. Raw-ветка ограничена `max_tokens: 16384`, mirror-ветка — объявленным моделью
  лимитом вывода. Превышение схемного лимита обрезается при построении строки с
  завершающим `…` (см. остаточные риски).
- Маппинг статуса строки: `running -> running`, `done -> success`,
  `refused -> failed`, `error -> failed`, `no-enabled-models -> failed`; точный статус
  всегда доступен в `takeover.status`.
- `summaryText` строки — короткая локализуемая сводка (пункт + статус), без вывода.
- Продуктовая проекция `product-projection-subagents.ts` (существующие
  `onSubagentSpawned`/`onSubagentStopped`, строки 242 и 375) должна копировать новый
  `takeover` целиком при spawn и при terminal-обновлении; обе delivery-профиля (полный
  и компактный) несут данные в терминальной строке.
- Cold replay обязан сохранять `takeover` — это требуемое поведение фичи, а не
  подтверждённый факт текущего кода. Изменение проекции/гидратации входит в
  реализационную задачу ветки runtime/projection; доказательство — интеграционный
  replay-тест, который загружает сессию с диска и сравнивает `takeover.status`,
  `modelId` и `output` с live-проекцией. Механизм восстановления расширений строки в
  текущем коде не подтверждён (`takeover` отсутствует и в `rows.ts`, и в v4-проекции);
  кандидаты для проверки при реализации — `transcript-hydration-parts.ts`,
  `cold-event-merge.ts`, `product-projection-core.ts`. Инвариант: после холодной
  загрузки сессии строка takeover имеет те же значения `takeover.status`, `modelId` и
  `output`, что и в live-проекции.

## UI настроек

- Навигация: в
  `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts`
  (группа `workspace-intelligence`, строки 279-300) добавляется третий пункт
  `workspace-intelligence:uncensored-models` после `local-model` и `embeddings`, тип
  `codeIntelligence`, подпись из i18n.
- Пункт виден, когда доступен соответствующий порт настроек; на remote/web без порта
  пункт скрыт, как скрывается local-model карточка при отсутствии вложенного порта.
- Детальная панель: новый компонент `UncensoredModelSettings` и ветка в
  `packages/ui/src/settings/model-provider-section/container/ModelProviderSectionView.tsx`
  (рядом с ветками `local-model`/`embeddings`, строки 125-144), тот же `SectionLayout` и
  стиль.
- Поля: API URL (`Input`), API Key (`Input type="password"`, при
  `apiKeyConfigured: true` placeholder-маска вместо значения, действие «Забыть токен»,
  как в `EmbeddingProviderSettings.tsx:512-526,550-561`).
- Список моделей — ручной редактор строк: «Добавить модель» добавляет строку с пустым
  `id`-`Input` и переключателем `enabled` (существующие `Switch`/`Checkbox`,
  `packages/ui/src/components/ui/switch.tsx`, `checkbox.tsx`), у строки есть удаление,
  порядок меняется кнопками вверх/вниз. Автоподбора моделей у провайдера нет: endpoint
  discovery не вызывается; Embedding для сравнения использует текстовое поле модели
  (`EmbeddingProviderSettings.tsx:500-511`), а в контракте code intelligence нет метода
  перечисления моделей (`packages/services/src/code-intelligence/contract.ts`).
- Сохранение отправляет полный список в текущем порядке; пустое поле URL отправляет
  `apiUrl: null` (полный сброс). Новый ключ хранится только в локальном состоянии формы
  и очищается после успешного сохранения; сохранённый ключ не читается и не
  отображается.
- Состояния загрузки и ошибки — `role="status"` / `role="alert"`; ошибки валидации
  называют поле, но не выводят секрет.
- Только токены `text-ui-*` и существующие компоненты (`Button`, `Input`, `Switch`,
  `Checkbox`); инлайновых `font-size` нет.
- Все строки — через i18n; ключи добавляются в
  `packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`, `ru-RU.json`
  (минимум: `settings.uncensored.navigationLabel`, `apiUrl`, `apiKey`,
  `apiKeyConfigured`, `forgetToken`, `models`, `addModel`, `moveUp`, `moveDown`,
  `remove`, `save`, `saved`, `loadFailed`, `invalidUrl`, `invalidModel`,
  `duplicateModel`).

## UI карточки takeover

- Отдельная карточка в области строк subagent; не встраивается в assistant-текст и не
  заменяет сообщение с отказом.
- Показывает: текст пункта (`itemText`), `itemIndex`, модель (`modelId` или «—»),
  локализованный статус, полный `output` (прокручиваемая моноширинная область),
  `reason` при наличии.
- Для `no-enabled-models` — явный текст «нет включённых моделей» без пустого блока
  вывода; для `error`/`refused` — причина, если есть.
- Данные берутся только из `takeover` строки; второй источник состояния не создаётся.
- Доступность: заголовок карточки связан с областью вывода, статус озвучивается,
  клавиатурная прокрутка работает; темы и узкие раскладки — как у соседних карточек.
- Только `text-ui-*` токены; ключи i18n `chat.uncensoredTakeover.*` в трёх локалях.

## Безопасность

- Ключ никогда не попадает в логи, события, строки проекта, синтетический промпт,
  сообщения об ошибках и `uncensored-settings.json`.
- Логи пишут только: `taskId`, `itemIndex`, `modelId`, статус, HTTP-статус, длительность;
  ключ и тело ответа провайдера исключены.
- Host читает ключ из `ICredentialService` непосредственно перед сборкой ответа
  `uncensored/getConfig`; CLI использует его только в заголовке `Authorization`.
- Редиректы запрещены; URL с userinfo/query/fragment отклоняется до сохранения.
- Пустой ключ допустим для локальных совместимых endpoint'ов; заголовок в этом случае не
  отправляется.
- Отмена turn прерывает HTTP-попытку через `AbortSignal` и не оставляет висящую строку:
  терминальное событие отправляется со статусом `error`.

## Версионирование

- Фича не меняет версию корневого `package.json`; релизный коммит с версией — отдельный
  (`git log -- package.json` содержит только коммиты «Выпустить macOS Preview …»).
- `subagentRowSchema.takeover` и поле внутреннего типа `rawFinishReason` —
  необязательные, обратно совместимые добавления; версия протокола не поднимается.
- `model.refusal` — аддитивный тип события. Совместимость смешанных версий: старый
  reader игнорирует неизвестный тип, новый CLI со старым Host получает ошибку
  `uncensored/getConfig` и завершает перехват статусом `error` без HTTP.

## Acceptance

### 1. Секция настроек и переживание перезапуска

Given локальный workspace и пустые настройки.
When пользователь открывает секцию настроек, сохраняет URL, ключ и три модели с разными
`enabled` и порядком, затем перезапускает приложение.
Then секция содержит поля `apiUrl`, write-only `apiKey` и ручной список моделей с
переключателями `enabled`; статус возвращает тот же URL, `apiKeyConfigured: true`, тот
же порядок и те же флаги `enabled`; ответ статуса, события и логи не содержат строку
ключа; повторный `null` для ключа оставляет конфигурацию без секрета.
Test intent: unit-тест хранилища (round-trip, восстановление после нового экземпляра
сервиса), контрактный тест strict-схемы, тест редактирования формы.

### 2. Десять пунктов, отказ по одному

Given todo из 10 пунктов, ни один ещё не выполнен; на одном провайдер возвращает
`finishReason: "refusal"`; включена одна нецензурированная модель.
When шаг завершается без tool calls.
Then создаётся один `model.refusal`, одна карточка takeover, ровно один HTTP-вызов
вспомогательной модели; её тело содержит только текст отказанного пункта и не более
трёх ограниченных фрагментов; полный prompt, история turn, полный todo-список и тексты
других пунктов отсутствуют; основная модель получает продолжение, помечает пункт
`completed` через `TodoWrite` и выполняет оставшиеся 9 пунктов, не повторяя завершённые.
Test intent: runtime-тест с fake-портом конфигурации и fake-fetch; обязательная
негативная проверка `assertTakeoverRequestBodyExcludesFullPrompt(capturedRequests)`
(см. раздел «Минимальный контекст и запрос»); assert одного `model.refusal` и одной
terminal-строки.

### 3. Fallback и отсутствие включённых моделей

Given две включённые модели; первая возвращает 500, сетевую ошибку или
`finish_reason: "content_filter"`.
When перехват выполняет попытки.
Then вторая модель вызывается, её успешный вывод становится терминальным `done`; при
отказе/ошибке обеих терминальный статус равен статусу последней попытки. Если все
модели `enabled: false` или список пуст, строка получает `no-enabled-models`,
`modelId: null`, и fake-fetch фиксирует 0 вызовов; тест доказывает отсутствие сети.
Test intent: параметризованный runtime-тест маршрутизации и no-enabled без HTTP.

### 4. Chat sub-run: строка, карточка, дедупликация

Given отказ по атрибутированному пункту.
When выполняются spawn, попытки и stop.
Then чат показывает отдельный sub-run с `takeover.modelId` и полным `takeover.output`
(не встроенный в assistant-текст); `SubagentSpawned`/`SubagentStopped` несут
`agentType: "uncensored-takeover"`, детерминированный `agentId`, `takeover` с пунктом,
моделью, статусом и выводом; проекция создаёт одну строку; повторный вызов с тем же
ключом не создаёт второе событие и не делает второй HTTP-вызов; после перезагрузки
сессии из transcript строка и карточка видны с теми же `takeover.status`, `modelId` и
`output`.
Test intent: тест live-проекции, интеграционный replay-тест холодной гидратации и тест
идемпотентности стора. Сохранение `takeover` при холодном replay — требуемое поведение
и реализационная задача ветки runtime/projection; доказательство даёт replay-тест.

### 5. Финальный текст при перехвате

Given основная модель отказалась от пункта, включена резервная модель.
When перехват завершается.
Then последним видимым и персистентным assistant-текстом хода является результат
резервной модели; исходный отказ остаётся в истории и метаданных.

Сценарии:

- одиночный отказ + ответ: plain chat, резервная модель вернула `done` с непустым
  `output`; ход завершается сразу, финальный assistant-message равен `output`, отказ
  основной модели остаётся предыдущим сообщением; следующего model step нет;
- два отказа подряд: после reminder основная модель повторно отказалась от того же
  пункта; новых `model.refusal`/spawn/stop и HTTP нет, финальный assistant-message равен
  сохранённому `output` резервной модели и записан один раз;
- ошибка резервной модели: терминальный `error`; финальный текст — явный текст ошибки
  со статусом и причиной, а не отказ основной модели; карточка takeover имеет статус
  `error`;
- пустой ответ резервной модели: терминальный `error`, `reason: "empty-response"`;
  финальный текст — явный текст ошибки, а не отказ основной модели;
- текстовый отказ резервной модели (в том числе в legacy raw-ветке): терминальный
  `refused`, `reason: "text-refusal"`; финальный текст — явный текст ошибки, а не отказ
  основной или резервной модели; карточка takeover имеет статус `refused`;
- todo с другими пунктами: остаются другие `pending`/`in_progress` пункты; финальный
  assistant-message не пишется, добавляется system-reminder, ход продолжается; отказ и
  карточка takeover сохранены;
- todo без оставшихся пунктов: обработанный пункт — последний `pending`/`in_progress`;
  финальный assistant-message равен результату резервной модели, system-reminder не
  добавляется, следующего model step нет; статус пункта движок не меняет.

Test intent: focused runtime-тесты гейта с fake runtime: последний persisted `text` part,
атрибуция `providerId`/`modelId`, отсутствие повторных событий/HTTP и сохранение отказа в
`turnRequestState.entries`; для ветки `finish` проверяется `finalText`, из которого
формируется `TurnComplete.response`.

### 6. Thinking-модель не теряет ответ в reasoning

Given включённая резервная модель с суффиксом `:thinking`.
When выполняется попытка.
Then в raw-запрос уходит id без суффикса и `max_tokens: 16384`, mirror-вызов получает
`reasoning_effort: "none"`; суффикс снимается только в конце id, тег `llama3:8b` не
меняется. При пустом `content` и непустом `reasoning` терминальный статус — `error`,
`reason: "empty-content"`, финальный текст — явная ошибка, а не reasoning и не отказ
основной модели. При непустом `content` — терминальный `done`, а `modelId` в карточке и
durable-строке остаётся исходным, с суффиксом.
Test intent: unit-тесты оркестратора с fake `generate`/`fetch` на оба транспорта.

### 7. Remote-workspace получает те же провайдеры и модели

Given настройки uncensored сохранены локально и открыт remote-workspace.
When workspace-слой монтируется или remote-сессия переподключается.
Then в целевой Environment переносятся провайдеры с ключом и моделями через его
`updateConfig`, после чего список моделей в композере удалённого workspace содержит
mirror-модель, а takeover находит включённые модели. Повторное монтирование без
изменений не пишет в Environment; ошибка переноса не блокирует локальный UI.
Test intent: unit-тесты чистой функции переноса (запись, идемпотентность, пустой
источник, ошибка записи).

### 8. Перехват работает в remote-workspace без файла настроек

Given remote Environment с provisioned mirror-провайдером и пустым файлом настроек.
When основная модель отказывается от пункта.
Then `getTakeoverConfig` восстанавливает провайдера из реестра (включённые модели,
`providerId`), запрос уходит в uncensored-модель, а не завершается `no-enabled-models`;
`apiUrl` собран из baseUrl, `/chat/completions` не дублируется. Непустой стор остаётся
приоритетным; при недоступном реестре конфиг пустой без падения.
Test intent: unit-тесты `getTakeoverConfig` с fake-стором и fake-view.

## Приложение: проверки и коммит (не критерий приёмки)

Из корня репозитория:

```bash
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm verify:pre-push
```

Точечные тесты запускаются скриптом тестов затронутого пакета из его `package.json`
(имена пакетов и скриптов сверить на момент реализации; не использовать полный
`pnpm test`
без явного запроса). Обязательные наборы:

- хранилище настроек и strict-схемы: round-trip, валидация URL, уникальность/лимит
  моделей, отсутствие ключа в статусе, атомарная замена файла без временных остатков;
- runtime: детект отказа (подтверждённые значения, нормализация `_`/`-`, негативные
  случаи `stop`/`tool-calls`/`length`/`unknown`), атрибуция пункта, бюджет контекста,
  `assertTakeoverRequestBodyExcludesFullPrompt`, маршрутизация, `no-enabled-models` без
  HTTP, дедупликация, порядок событий;
- thinking-модели: снятие суффикса `:thinking` в обеих ветках при сохранении исходного
  `modelId` в атрибуции, `max_tokens: 16384` в raw-теле, пустой `content` при непустом
  `reasoning` → `error`/`empty-content`;
- проекция: `takeover` в live и в холодном replay, оба delivery-профиля;
- UI: рендер формы и карточки, ручной редактор моделей, i18n-ключи в трёх локалях,
  отсутствие утечки ключа.

Коммит фичи не меняет версию корневого `package.json`: `git log -- package.json`
показывает только релизные коммиты «Выпустить macOS Preview …»; bump остаётся
релизным коммитам. Изменения фичи, тестов и спецификации фиксируются одним коммитом
фичи без bump; фактические логи команд — в отчёте, провал любой команды — блокер.

## Остаточные риски

- Провайдерские адаптеры, которые не заполняют `rawFinishReason` и нормализуют отказ в
  `other`, не дадут сработать перехвату. Это осознанное ограничение: эвристики по словам
  текста запрещены. Смягчение — добавить диагностическое поле finish reason в модель
  логов и проверять его покрытие тестами адаптеров.
- Холодная гидратация: механизм восстановления расширений строки в текущем коде не
  подтверждён; без изменения проекции `takeover` и полный `output` будут потеряны.
  Требование и интеграционный replay-тест заданы в разделе «Chat sub-run и проекция»;
  точный механизм — открытый вопрос 3.
- Доступность Host-порта: на Web, mobile replay и remote workspace без явно
  расширенного host-контракта вызов `uncensored/getConfig` недоступен, поэтому
  перехват даёт `error`, а пункт настроек скрыт. Расширение remote-контракта — отдельная
  задача.
- Смешанные версии CLI/Host: новый CLI со старым Host даёт `error` без HTTP; старый
  CLI с новым Host просто не использует функцию и игнорирует новые события.
- Ограничение `output` в 64 000 символов схемы может обрезать очень длинный ответ
  модели при `max_tokens: 4096`; усечение маркируется `…` и не влияет на статус.
- Отсутствие ретраев означает, что кратковременный сбой единственной включённой модели
  даёт терминальный `error`; повтор возможен только новой попыткой пользователя.
- Если провайдер не понимает ни `reasoning_effort: "none"`, ни снятие суффикса, ответ
  thinking-модели может снова уйти целиком в reasoning. Тогда действует высокий бюджет
  (raw `16384`), а при исчерпании — явная ошибка `empty-content`, а не подстановка
  reasoning-текста.

## Открытые вопросы, требующие кода

1. Точные имена renderer→Host методов для чтения/записи настроек: определяются по
   образцу соседних сервисов в `packages/services/src/code-intelligence/` и
   `packages/ui/src/hooks/useServices.tsx`, фиксируются контрактным тестом.
2. Файл и формат durable-стора `UncensoredTakeoverStore` внутри CLI session store:
   реализуется в модуле-владельце `SessionStorePort`; путь и имя файла фиксируются в
   реализации и тесте, спецификация задаёт только ключ, детерминированный `agentId` и
   атомарность.
3. Холодный replay расширения `takeover`: механизм в текущем коде не найден. Нужно
   реализовать проекцию/гидратацию (кандидаты — `transcript-hydration-parts.ts`,
   `cold-event-merge.ts`, `product-projection-core.ts`) и доказать интеграционным
   replay-тестом, что терминальная строка сохраняет `takeover.status`, `modelId` и
   `output`. Допустим любой механизм, сохраняющий этот инвариант.
