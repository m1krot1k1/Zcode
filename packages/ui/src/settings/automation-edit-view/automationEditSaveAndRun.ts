/**
 * 保存后立即运行：保存失败时不运行，避免对未落库的编辑执行任务。
 */
export async function saveAndRunAutomation(
  save: () => Promise<boolean>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  if (!(await save())) return false;
  await run();
  return true;
}
