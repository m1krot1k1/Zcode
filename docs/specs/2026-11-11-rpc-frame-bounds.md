# Верхняя граница RPC-кадра и безопасный разбор неизвестного тега

## Назначение

Зафиксировать явный верхний предел одного физического кадра `@zcode/rpc`, порядок проверки
длины до ожидания/выделения тела, типизированную ошибку для oversize-кадра и безопасное
поведение при неизвестном/повреждённом теге. Ограничение должно применяться и в
`SocketProtocol`, и в `PersistentProtocol` (обе реализации читают один и тот же 13-байтовый
заголовок), а `ChannelServer` не должен падать на невалидном Channel-сообщении.

## Владелец состояния

- `MAX_FRAME_BYTES` и `RpcFrameLimitError` — единственный владелец контракта:
  `packages/rpc/src/protocol.ts`.
- `resolveFrameByteLimit()` — единственная точка нормализации лимита: значение можно только
  уменьшить относительно `MAX_FRAME_BYTES`; `0`, отрицательные, дробные, `NaN` и
  `Infinity` отклоняются `RangeError`.
- `SocketProtocol`、`PersistentProtocol` и `MessagePortProtocol` владеют только собственным
  состоянием разбора (`ChunkStream`, `discardRemaining`) и не вводят второй формат кадра.
- `ChannelServer` владеет проверкой размера входящего Channel-сообщения и безопасным
  разбором его заголовка; второй сериализатор не создаётся.
- `ChannelClient` в этот change set не входит; его разбор заголовка остаётся прежним
  (см. «Остаточные риски»).

## Формат кадра (текущий, подтверждённый исходником)

`packages/rpc/src/protocol.ts:272-311`: заголовок 13 байт
(`HEADER_SIZE`/`readProtocolFrameHeader` — `protocol.ts:296-311`)

```text
type(1) | id(4 BE) | ack(4 BE) | length(4 BE)
```

`length` — длина payload, до 4 294 967 295 байт. `HEADER_SIZE + length` вычисляется в
`number`; переполнения safe integer здесь нет, но без явного предела peer может держать
соединение в ожидании гигабайтного тела и накапливать входящий буфер без границы.

Channel-сообщение (`serialize`/`deserialize`) — отдельный слой: `[тип][VQL длина][данные]`,
`header` — массив `[RequestType|ResponseType, id, channelName, name]`, `body` — аргумент или
результат. Неизвестный `DataType` в `deserialize` возвращает `undefined`
(`packages/rpc/src/serialization.ts:193-218`). До этого change set `ChannelServer` без проверки
читал `header[0]` и падал `TypeError` на повреждённом теге; текущая защита —
`packages/rpc/src/channelServer.ts:112-180`.

## Контракт

1. `MAX_FRAME_BYTES = 96 * 1024 * 1024` (96 MiB). Обоснование:
   - самый большой одиночный payload, который сегодня проходит через Channel RPC, —
     архив plugin sync с дефолтным пределом 50 MiB
     (`packages/services/src/plugin-sync/pluginSyncService.ts:73`); он передаётся как
     `{ archive: Uint8Array }`, а `serialize` кодирует вложенный `Uint8Array` в base64
     (`packages/rpc/src/serialization.ts:179-187`), то есть на проводе это ~66.7 MiB плюс
     JSON-оболочка;
   - следом skill sync с 20 MiB (`packages/services/src/skill-sync/skillSyncService.ts:27`)
     и web remote transport с 16 MiB
     (`packages/shared/src/web-remote-control-rpc-transport.ts:10-16`);
   - 96 MiB покрывает base64-раздутый 50 MiB архив с запасом на ключи/экранирование и
     одновременно ограничивает память одного недочитанного кадра;
   - `PROTOCOL_V4_LIMITS.maxFrameBytes = 1 MiB` — предел физического кадра доставки v4, а не
     нижнего транспортного RPC; переиспользовать его здесь нельзя без разрыва sync-архивов.
2. Проверка `length > limit` выполняется сразу после чтения заголовка и **до** любого
   ожидания тела или выделения буфера под тело (`protocol.ts:400-409`,
   `persistent-protocol.ts:207-219`); encode-граница — `protocol.ts:372-382` (Socket),
   `persistent-protocol.ts:139-152` (Persistent), `protocol.ts:558-565` (MessagePort) и
   `protocol.ts:326-330` (`writeProtocolMessage`). Для `length === limit` кадр принимается.
3. Oversize-кадр:
   - заголовок потребляется;
   - на `onError` (опциональное событие `IMessagePassingProtocol`) публикуется
     `RpcFrameLimitError` с `code = "RPC_FRAME_TOO_LARGE"`, `frameLength` и `maxFrameBytes`;
   - payload ровно `length` байт отбрасывается потоково через `ChunkStream.discard()` без
     выделения буфера размером `length`;
   - разбор продолжается со следующего кадра. Соединение и процесс не падают, ошибка не
     является unhandled rejection/исключением из `onData`.
   - если один сетевой chunk содержит весь oversize payload, он уже был принят
     транспортом; протокол не делает второй аллокации под объявленную длину.
4. `PersistentProtocol` при oversize-кадре применяет `ack` из его заголовка (как для любого
   корректно прочитанного заголовка), обновляет `lastAckTime` и только затем отбрасывает тело.
   `incomingAckId` не продвигается: payload не доставлен, поэтому следующий исходящий ACK не
   подтверждает этот кадр; при переподключении пир может повторить его и снова получить
   `RpcFrameLimitError` (детерминированный отказ, не потеря данных). Порядок событий:
   `processAck` → `discardRemaining = length` → `onError(oversize)` → потоковое отбрасывание →
   следующий валидный `onMessage`. Счётчик отбрасывания взводится **до** `onError`, чтобы
   повторный вход из подписчика (например, синхронный `socket.emitData` в обработчике) уже
   находился в режиме discard и не мог разобрать тело как заголовок следующего кадра.
5. Фрагментация: заголовок читается через `peek(HEADER_SIZE)`, тело — только после того, как
   `ChunkStream.byteLength >= HEADER_SIZE + length`; частичный кадр не потребляется и не
   публикуется.
6. Обрезанный кадр (header объявляет больше байт, чем пришло) остаётся в буфере, сообщение не
   публикуется, ошибка не генерируется: это неотличимо от медленной доставки. Верхняя
   граница удерживаемого буфера — `HEADER_SIZE + limit`.
7. Неизвестный `ProtocolMessageType` в `SocketProtocol`/`PersistentProtocol` игнорируется
   (существующая семантика `switch` без throw); `PersistentProtocol` при этом обновляет ACK.
8. `ChannelServer`:
   - сообщение длиннее своего предела (по умолчанию `MAX_FRAME_BYTES`, можно только
     уменьшить) игнорируется, а `RpcFrameLimitError` передаётся в опциональный
     `ChannelServerOptions.onFrameError`; это независимая вторая линия защиты после
     транспортного `onError` (у `MessagePortProtocol` транспорт тоже проверяет размер);
   - `deserialize` оборачивается в `try/catch`; исключение разбора не выходит из
     `onMessage`;
   - заголовок принимается только если это массив с числовым первым элементом; для
     `Promise`/`EventListen` обязательны `number id`, `string channelName`,
     `string name`, для `PromiseCancel`/`EventDispose` — `number id`; иначе сообщение
     считается повреждённым и игнорируется;
   - неизвестный `RequestType` игнорируется по существующему контракту `switch`;
   - для неизвестного/повреждённого тега ответ не отправляется и соединение не рвётся;
   - исключение внутри `onFrameError` не влияет на обслуживание следующих сообщений.
9. `MessagePortProtocol` не меняет формат (у него уже есть границы сообщений), но применяет тот
   же контракт размера к самим сообщениям: `maxFrameBytes` в опциях (только ужесточение),
   входящий `Uint8Array` длиннее предела не доставляется и публикуется через новый
   `onError` как `RpcFrameLimitError`; `send()` бросает ту же ошибку до `postMessage`.
   `sendFlowState` и control-объекты под лимит не подпадают. Входящие Channel-сообщения
   дополнительно защищены проверкой `ChannelServer`.
10. Типизированная ошибка является обычным `Error`-подклассом и не требует нового канала
    ответа; `onError` — опциональное свойство интерфейса, поэтому сторонние реализации
    `IMessagePassingProtocol` остаются совместимыми.
11. Encode boundary: `SocketProtocol.send`/`PersistentProtocol.send` проверяют payload против
    своего effective limit и бросают `RpcFrameLimitError` до любой записи в сокет или
    постановки в replay-очередь; `writeProtocolMessage` повторно проверяет против
    `MAX_FRAME_BYTES` для прямых вызовов. Верхняя граница одна и та же константа, второй
    формат/второй сериализатор не вводится.
12. Compatibility flag: `MAX_FRAME_BYTES = 96 MiB` — это **решение о совместимости**, а не
    выведенный из протокола теоретический предел. Оно выбрано так, чтобы текущие sync-архивы
    проходили без изменения их собственных лимитов. Если появится payload ближе ~60 MiB в
    base64, значение нужно пересмотреть вместе с лимитами plugin/skill sync, а не молча
    поднимать константу.
13. Отличие от исходной формулировки R08: oversize-кадр **не закрывает соединение**. R08
    предлагал typed close reason; выбран reject-and-continue, потому что он сохраняет
    наблюдаемость через `onError`, не теряет последующие валидные кадры и не требует нового
    варианта `onClose` в публичном интерфейсе. Это осознанное решение, а не недоделка.

## Порядок событий

```text
socket.onData(chunk)
  -> ChunkStream.acceptChunk
  -> discardRemaining > 0 ? discard(min(remaining, buffered)) : peek header
  -> length > limit
       -> skip(HEADER_SIZE)
       -> (PersistentProtocol) processAck(ack); lastAckTime = now
       -> discardRemaining = length     // 先于 onError，保证重入也处于 discard 模式
       -> onError(RpcFrameLimitError)
       -> discard buffered part (без allocation)
       -> продолжить со следующего кадра
  -> length <= limit и кадр не собран
       -> ждать следующий chunk (без потребления header)
  -> кадр собран
       -> skip header / read body
       -> onMessage(body)
```

## Совместимость

- Валидные кадры до 96 MiB включительно обрабатываются как раньше; известные production
  payload'ы (50 MiB plugin archive → ~66.7 MiB в base64, 20 MiB skill archive, 16 MiB web
  remote message, 512 KiB attachment chunk) проходят.
- Опции `maxFrameBytes` у `SocketProtocol`/`PersistentProtocol`/`MessagePortProtocol` и пятый
  аргумент `ChannelServer` только ужесточают предел; поднять его выше `MAX_FRAME_BYTES` нельзя.
- Публичный экспорт `@zcode/rpc` (`packages/rpc/src/index.ts`) в этом change set **не**
  менялся (файл вне назначенного write scope): `MAX_FRAME_BYTES`, `RpcFrameLimitError`,
  `resolveFrameByteLimit`, `MessagePortProtocolOptions` и `ChannelServerOptions`
  экспортируются из своих модулей и доступны прямым внутренним импортом, но потребителям
  пакета нужен follow-up, добавляющий их в barrel (`packages/rpc/src/index.ts`) и
  `channels.ts`.

## Приёмочные сценарии

| ID       | Сценарий                                                            | Ожидаемый результат                                                                                                  |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| RPCB-01a | `length === limit - 1`                                              | Кадр принят, `onMessage` вызван один раз, `onError` не вызван.                                                       |
| RPCB-01b | `length === limit`                                                  | Кадр принят, `onMessage` вызван один раз, `onError` не вызван.                                                       |
| RPCB-02  | `length === limit + 1`                                              | `onError` с `RpcFrameLimitError` (`code`, `frameLength`, `maxFrameBytes`); `onMessage` не вызван.                    |
| RPCB-03  | `length === 0xFFFFFFFF`, в буфере только заголовок                  | Ошибка типизирована; `VSBuffer.alloc` не вызывается с объявленной длиной; процесс не падает.                         |
| RPCB-04  | Oversize-кадр, затем валидный кадр                                  | Тело oversize отброшено без allocation, следующий кадр доставлен.                                                    |
| RPCB-05  | Неизвестный `ProtocolMessageType` (с payload и с `length = 0`)      | Кадр игнорируется, следующий `Regular` доставлен; исключений нет.                                                    |
| RPCB-06  | Заголовок и тело приходят фрагментами (включая заголовок по байтам) | Сообщение доставлено ровно один раз и целиком.                                                                       |
| RPCB-07  | Обрезанный кадр, затем остаток тела                                 | До прихода остатка сообщения нет; после — одно сообщение; тело не выделяется заранее; ошибки нет.                    |
| RPCB-08  | `PersistentProtocol` получает oversize-кадр с ACK                   | ACK применён, ошибка опубликована, следующий кадр доставлен.                                                         |
| RPCB-09  | `ChannelServer` получает неизвестный DataType/RequestType/мусор     | Исключение не выходит из `onMessage`, ответ не отправляется, соединение живо.                                        |
| RPCB-09a | `ChannelServer` получает повреждённый body (JSON.parse бросает)     | Исключение не выходит из `onMessage`; следующий валидный запрос обслуживается.                                       |
| RPCB-09b | `ChannelServer` получает Promise без `channelName`/`name`           | Сообщение отброшено, в pending-очередь ничего не попало; следующий запрос обслуживается.                             |
| RPCB-10  | `ChannelServer` получает сообщение больше своего предела            | Сообщение игнорируется без разбора; сервер продолжает обслуживать следующие запросы.                                 |
| RPCB-10a | `ChannelServer` формирует oversize-ответ                            | Ответ не отправляется, `onFrameError` получает ровно один `RpcFrameLimitError`, сервер обслуживает следующий запрос. |
| RPCB-11  | Опция `maxFrameBytes = 0`, дробь, `NaN`, `Infinity`                 | `RangeError` при создании протокола; неявного fallback к пределу нет.                                                |
| RPCB-12  | Опция `maxFrameBytes` больше `MAX_FRAME_BYTES`                      | Эффективный предел остаётся `MAX_FRAME_BYTES` (ужесточение возможно, ослабление — нет).                              |
| RPCB-13  | `MessagePortProtocol` получает сообщение `limit + 1`                | Сообщение не доставлено, `onError` получает `RpcFrameLimitError`; `limit` доставляется.                              |
| RPCB-14  | `MessagePortProtocol.send` с payload `limit + 1`                    | Бросает `RpcFrameLimitError`, `postMessage` не вызван.                                                               |
| RPCB-15  | `onError` не подписан / подписчик бросает                           | Исключение не выходит из `onData`; разбор продолжается со следующего кадра.                                          |

## Проверки

- Unit: `packages/rpc/test/frame-bounds.test.ts` покрывает RPCB-01a…RPCB-15 для
  `SocketProtocol`, `PersistentProtocol`, `MessagePortProtocol` и `ChannelServer`. Это штатный
  каталог `packages/*/test/**/*.test.ts` из корневого `vitest.config.ts`, поэтому файл входит в
  `pnpm test:unit` и affected-выбор.
- Статус прогона в этом change set: **не выполнен** (окружение не дало запустить Bash:
  `spawn /bin/zsh EAGAIN`). Ни один результат ниже не подтверждён фактическим выводом;
  до merge нужно выполнить команды из этого раздела.
- Ранее созданная копия набора в `packages/rpc/src/__tests__/frame-bounds.test.ts` остаётся
  вне write scope этого change set и уступает по покрытию каноническому файлу. Её следует
  удалить или перевести в реэкспорт отдельным изменением; запуск копии шёл своим конфигом:
  `pnpm --dir packages/rpc exec vitest run --config src/__tests__/vitest.config.ts`.
  Дополнительный риск (не проверено запуском): `packages/rpc/tsconfig.json` включает
  `src/**/*.ts`, поэтому при следующем `tsc -b` копия теста попадёт в эмит `dist/`;
  текущий `tsconfig.tsbuildinfo` её ещё не содержит. Это закрывается тем же follow-up.
- Регрессия: существующие `packages/rpc/test/protocol.test.ts` и
  `packages/rpc/test/channels.test.ts` должны проходить без изменения ожиданий
  (`pnpm --dir packages/rpc test`).
- Typecheck пакета: `pnpm --dir packages/rpc exec tsc -p tsconfig.json --noEmit` (или
  эквивалент `tsc -b`), lint пакета: `pnpm --dir packages/rpc exec oxlint`.

## Остаточные риски

- `ChannelClient.onBuffer` (`packages/rpc/src/channelClient.ts:210-231`) имеет ту же
  незащищённую форму разбора, что и `ChannelServer` до этого change set. Файл вне
  назначенного write scope; рекомендуется отдельным изменением переиспользовать общий
  безопасный разбор заголовка на клиенте.
- `deserialize` (`packages/rpc/src/serialization.ts:193-218`) доверяет VQL-длине массива:
  маленькое сообщение может объявить `Array` длиной до 2^31-1 и заставить цикл создать
  огромный массив. Предел кадра это не закрывает; исправление требует проверки «длина массива
  не больше оставшихся байт» в самом `deserialize`, файл вне write scope. Кадровый лимит
  ограничивает лишь размер входного буфера (96 MiB).
- Первое сообщение `IPCServer` читает `deserialize` без защиты
  (`packages/rpc/src/ipc.ts:113-124`); повреждённый первый кадр даёт `ctx = undefined`, но не
  исключение, поскольку `deserialize` возвращает `undefined` для неизвестного тега. Ошибка
  разбора VQL/JSON там всё ещё может выйти наружу; файл вне write scope.
- `PersistentProtocol` по-прежнему ограничивает неподтверждённые данные 8 MiB
  (`replayBufferMaxBytes`) и 45 s: это строже нового кадрового предела. 20–50 MiB архив
  поверх `PersistentProtocol` завершится `onClose` (существующее поведение, не изменено);
  сегодня крупные архивы идут через `SocketProtocol`/`MessagePortProtocol`.
- `remoteMediaPreviewProxy` (`packages/desktop/src/host/remoteMediaPreviewProxy.ts:16-18`)
  умеет читать файлы до 512 MiB, но отдаёт их собственным HTTP-чанками по 1 MiB, а не одним
  RPC-кадром. Поэтому 96 MiB не ограничивает этот путь; если файл когда-нибудь пойдёт одним
  Channel-сообщением, лимит придётся пересматривать вместе с транспортом.
- Полностью отбросить уже полученный от транспорта chunk нельзя: память под него выделяет
  socket-адаптер. Контракт ограничивает только дополнительные аллокации самого протокола.
- Долгий `discardRemaining` (например, объявлено 4 GiB) не выделяет память, но соединение
  остаётся занятым отбрасыванием до прихода всех байт или закрытия сокета; владелец
  соединения может закрыть transport по своему таймауту.
