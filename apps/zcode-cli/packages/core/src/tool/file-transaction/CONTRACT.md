# cli-file-transaction

Реестр канонических пофайловых RW-блокировок (`FileLockRegistry`) и базовый контракт мультифайловых транзакций (`F-02`).

Инварианты:

- Ключ изоляции всегда вычисляется как `${workspaceIdentity?.trim() || workspaceRootRealpath}\0${canonicalRealpath}`.
- `acquireBatch` всегда сортирует уникальные ключи лексикографически по UTF-16 code units перед захватом, исключая циклические ожидания (deadlock-free) при конкурирующих субагентах.
- При таймауте (`FILE_LOCK_TIMEOUT`) или отмене `AbortSignal` все уже захваченные блокировки пакета немедленно освобождаются.
- Единый экземпляр `FileLockRegistry` передаётся из родительской сессии `AgentRuntime` во все дочерние субагенты и файловые инструменты (`Write`, `Edit`, `ApplyPatch`).
