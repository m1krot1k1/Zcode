// 预留帧的 physical encode 与原子提交（从 v4-gateway 拆出）。
// 所有 physical wire 都被下游接受后才 commit publisher 水位。

import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type RoutedTopicFrame,
  type RoutedTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

export function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

/** 所有 physical wire 都被下游接受后才 commit publisher 水位。 */
export function emitReservedTopicFrame<F extends RoutedTopicFrame>(
  reservation: TopicFrameReservation<F>,
  emit: (wire: RoutedTopicWireFrame) => unknown,
): boolean {
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) emit(wire);
  return reservation.commit();
}
