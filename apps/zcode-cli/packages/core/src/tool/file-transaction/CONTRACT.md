# cli-file-transaction

Единый реестр канонических пофайловых RW-блокировок (`FileLockRegistry`), быстрый пре-коммитный AST/Syntax валидатор (`SyntaxValidator`) и двухфазный `FileTransactionManager` с гарантированным откатом (F-02, F-07).

Инварианты:

- Ключ изоляции всегда вычисляется как `${workspaceIdentity?.trim() || workspaceRootRealpath}\0${canonicalRealpath}`.
- `acquireBatch` всегда сортирует уникальные ключи лексикографически по UTF-16 code units перед захватом, исключая циклические ожидания (deadlock-free) при конкурирующих субагентах.
- При таймауте (`FILE_LOCK_TIMEOUT`) или отмене `AbortSignal` все уже захваченные блокировки пакета немедленно освобождаются.
- `releaseByHolder(holderId)` синхронно отменяет ожидающие запросы и освобождает активные гранты указанного владельца (и его дочерних `holderId:`), что используется каскадной отменой фоновых задач.
- Единый экземпляр `FileLockRegistry` передаётся из родительской сессии `AgentRuntime` во все дочерние субагенты и файловые инструменты (`Write`, `Edit`, `ApplyPatch`, `MultiEdit`).

Транзакции (`FileTransactionManager.executeTransaction`):

1. `Stage`: под отсортированными `exclusive-write` грантами снимается undo-снимок каждого пути (контент, существование, ревизия/mtime/hash) и вычисляются новые буферы в памяти. При включённом `enforceStaleReadGuard` расхождение с `readFileState` возвращает `rejected_stale` без записи.
2. `Validate`: `SyntaxValidator` проверяет изменённые буферы до записи на диск по дельта-правилу — отклоняются только новые синтаксические ошибки (`introducedErrors > 0`), что не блокирует легаси-файлы с уже существующими ошибками. При `rejected_syntax` диск остаётся нетронутым.
3. `Commit`: каждый буфер пишется атомарно (`temp` + `datasync` + `rename` в целевой директории через `atomic: true` ФС-порта). При любой ошибке на шаге `i` ранее применённые `0..i-1` восстанавливаются из undo-снимка в обратном порядке, созданные файлы удаляются; результат — `rolled_back_on_error`.

События (`onTransactionEvent`): `active_diff` перед коммитом, `committed` после успеха, `rolled_back` при откате/синтаксическом отклонении. Ключ события включает `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

