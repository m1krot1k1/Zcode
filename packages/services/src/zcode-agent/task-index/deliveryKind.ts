/**
 * task-index/deliveryKind.ts: Классификация доставки физического/логического кадра.
 * Чистые функции: описание транспорта, не доказательство выполненного side effect.
 */
import type { TopicDeliveryKind } from "./contracts.js";

export function deliveryKindOf(event: unknown): TopicDeliveryKind {
  const deliveryKind = (event as { deliveryKind?: unknown }).deliveryKind;
  return deliveryKind === "initial" || deliveryKind === "recovery" ? deliveryKind : "online";
}

export function faultDeliveryKindOf(event: unknown): TopicDeliveryKind | undefined {
  const deliveryKind = (event as { fault?: { deliveryKind?: unknown } }).fault?.deliveryKind;
  return deliveryKind === "initial" || deliveryKind === "online" || deliveryKind === "recovery"
    ? deliveryKind
    : undefined;
}
