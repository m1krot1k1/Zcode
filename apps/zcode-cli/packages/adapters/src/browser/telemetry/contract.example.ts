/**
 * Канонический сценарий: подключить телеметрию к странице, выполнить действие,
 * снять наблюдение и корректно освободить подписки.
 */
import type { BrowserActionObservation } from "@zcode/shared";
import type { Page } from "playwright-core";
import type { BrowserTelemetryController } from "./contract.js";

export async function observeSingleClick(
  telemetry: BrowserTelemetryController,
  page: Page,
  point: { x: number; y: number },
): Promise<BrowserActionObservation> {
  telemetry.attach(page);
  telemetry.beginAction(page);

  await page.mouse.click(point.x, point.y);

  const observation = await telemetry.observe(page, { includeScreenshot: true });
  // Освобождаем подписки, когда страница больше не нужна.
  telemetry.detach(page);
  return observation;
}
