import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ShareToolPresentationPayload } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { createContext } from "react";

export const ToolSnapshotContext = createContext<
  ReadonlyMap<number, ShareToolPresentationPayload>
>(new Map());

/** 把分享快照（展示态、图片、CUA 应用名）合并进 legacy 工具节点。 */
export function toolNodeWithSnapshot(
  row: ToolCallRow,
  snapshot: ShareToolPresentationPayload | undefined,
  resourceUrl: (ref: string) => string | undefined,
) {
  const node = toolCallRowToLegacyNode(row);
  if (!snapshot) return node;
  const images = snapshot.images?.flatMap((image) => {
    const src = resourceUrl(image.resource_id);
    return src ? [{ src, mimeType: image.mime_type }] : [];
  });
  node.toolCall.raw = {
    ...(node.toolCall.raw as Record<string, unknown>),
    ...(snapshot.display ? { display: snapshot.display } : {}),
    ...(images?.length
      ? { sharedImages: images, sharedImageSrc: images[0]!.src }
      : {}),
    ...(snapshot.app_name ? { cuaApp: { name: snapshot.app_name } } : {}),
  };
  return node;
}
