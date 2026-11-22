/**
 * Канонический сценарий: проверить окружение, снять кадр, кликнуть и напечатать текст
 * под уже выданными разрешениями.
 */
import type {
  LinuxCuaFrame,
  LinuxCuaHostContract,
  LinuxCuaScreenshotPermission,
} from "./contract.js";

export async function captureClickAndType(
  host: LinuxCuaHostContract,
  permissions: LinuxCuaScreenshotPermission,
): Promise<{
  report: Awaited<ReturnType<LinuxCuaHostContract["probe"]>>;
  frame: LinuxCuaFrame | null;
}> {
  const report = await host.probe();
  if (!report.available) {
    // Честный статус вместо исключения: вызывающий может показать причину в UI.
    return { report, frame: null };
  }

  const frame = await host.captureScreen({ format: "png" });
  if (frame) {
    // Координаты кадра → логические: scaleX/scaleY учитывают DPI.
    const logicalX = Math.round(frame.width / 2);
    const logicalY = Math.round(frame.height / 2);
    await host.execute({ kind: "click", options: { x: logicalX, y: logicalY } }, permissions);
    await host.execute({ kind: "type", options: { text: "hello", delayMs: 10 } }, permissions);
  }
  return { report, frame };
}
