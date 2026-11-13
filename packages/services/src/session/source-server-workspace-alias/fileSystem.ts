import { stat } from "node:fs/promises";

export async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}
