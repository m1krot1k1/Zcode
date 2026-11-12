import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Абсолютный путь к исходнику UI.
 *
 * Причина: тесты читают исходники как текст для структурных проверок. Относительный
 * `packages/ui/...` работал только из корня репозитория и падал через
 * `pnpm --filter @zcode/ui test` (cwd = packages/ui). Считаем путь от файла теста.
 */
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function uiSourcePath(...segments: string[]): string {
  return resolve(uiRoot, ...segments);
}
