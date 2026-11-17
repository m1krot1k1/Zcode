// ============================================================
// Изоляция потока транзакционных изменений по workspace (Этап 6.1c)
// ============================================================
//
// Ключ идентичности — единый для репозитория: `workspaceIdentity?.trim() ||
// workspacePath`. Хост может присылать кадры разных workspace в один поток
// (например, несколько pane в одном окне), поэтому сравнение выполняется
// до записи в store, а не только в селекторе.

/**
 * Проверяет, относится ли кадр к ожидаемому workspace.
 *
 * Сравнение нормализует оба ключа: payload от CLI всегда несёт `workspaceKey`,
 * а UI строит ожидание из workspaceIdentity/workspacePath. Пустой/отсутствующий
 * ключ в payload считается «не нашим» — иначе событие без идентичности
 * попало бы в произвольную панель.
 */
export function shouldMirrorFileTransaction(params: {
  payloadWorkspaceKey: string | undefined;
  workspaceKey: string;
}): boolean {
  const payloadKey = params.payloadWorkspaceKey?.trim();
  if (!payloadKey) return false;
  return payloadKey === params.workspaceKey.trim();
}
