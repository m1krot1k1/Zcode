import path from "node:path";
import { fileURLToPath } from "node:url";

// Модули живут на уровень глубже scripts/, поэтому корень репозитория поднимается на два уровня.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
