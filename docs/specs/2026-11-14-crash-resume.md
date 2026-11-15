# Безопасное продолжение задач после падения/закрытия

Статус: реализовано 2026-11-14 в ограниченном безопасном объёме.

## Scope

Автоматическое продолжение **корневой интерактивной сессии** после рестарта, если
последний turn был прерван. Продолжение идёт новым user-turn с явной инструкцией
не повторять уже сохранённые side effects.

Не входит: восстановление середины model stream, повторный запуск незавершённых
child-сессий по отдельности, восстановление in-memory event store, отмена
необратимых внешних эффектов.

## Владелец и порядок событий

Владелец — bootstrap resume path (`activateSessionForResumeInner`).

1. Resume читает persisted session и messages.
2. Если `lastOutcome !== "interrupted"`, parentID/taskType не root-interactive —
   auto-resume не запускается.
3. `findInterruptedUserMessage` берёт последнее реальное user-сообщение и проверяет,
   не остался ли tool в `running/pending`: такой tool означает неизвестный исход
   side effect, auto-resume запрещён.
4. Один раз на source user message пишется durable `session-auto-resume` entry.
   Это защита от бесконечного цикла, если continuation-turn снова падает.
5. `submitPrompt` получает `[auto-resume]` prompt: продолжить с последнего
   сохранённого состояния, не повторять tool calls с уже сохранённым результатом,
   проверить неизвестный side effect, не просить пользователя повторить запрос.

## Ограничения

- Если tool остался running/pending, автоматического продолжения нет: нужен
  ручной resume после проверки side effect.
- In-memory очередь `session_input` по-прежнему не переживает рестарт; восстанавливается
  только последний прерванный turn.
- Continuation — новый turn, а не побайтовое восстановление середины stream.
- Child-сессии не перезапускаются отдельно; их может пересоздать continuation-turn
  родителя.

## Приёмка

- Unit: `apps/zcode-cli/packages/bootstrap/tests/auto-resume.test.ts` — поиск последнего
  user-сообщения, блокировка при pending tool, защита от повторного auto-resume.
- Integration: resume сессии с `lastOutcome=interrupted` без pending tool запускает
  continuation; с running/pending tool — не запускает.
