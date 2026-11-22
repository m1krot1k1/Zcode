/* 安全边界约束：本文件（及其 share-readonly-timeline/ 子模块）被匿名公开分享页
 * （packages/web/src/share）直接引用，新增依赖必须考虑公开页 bundle 体积与
 * 无 Desktop 宿主（window.zcode / PlatformProvider / tab store）的运行环境；
 * Desktop 专属能力（如 open-with 子树）一律由消费方经组件注入，不得静态 import。
 *
 * 拆分：presentation 组件与数据模型在 v4/share-readonly-timeline/，本文件只保留
 * 公开 props / 入口组件与 provider 组合，保证导出与 hook 顺序不变。 */
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationShareContent } from "@/v4/ConversationShareContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";
import {
  ArtifactOpenContext,
  resolveImportedArtifactPath,
  useArtifactOpenContextValue,
} from "@/v4/share-readonly-timeline/artifactOpenContext.js";
import {
  EMPTY_ARTIFACT_NAMES,
  EMPTY_ARTIFACT_URLS,
  EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
} from "@/v4/share-readonly-timeline/constants.js";
import { ReadonlyTurn } from "@/v4/share-readonly-timeline/ReadonlyTurn.js";
import { buildShareTimelineModel } from "@/v4/share-readonly-timeline/shareTimelineModel.js";
import type { ConversationShareReadonlyTimelineProps } from "@/v4/share-readonly-timeline/types.js";
import { ToolSnapshotContext } from "@/v4/share-readonly-timeline/toolSnapshot.js";
import { useOpenShareExternalUrl } from "@/v4/share-readonly-timeline/useOpenShareExternalUrl.js";
import { useReadonlyLabels } from "@/v4/share-readonly-timeline/useReadonlyLabels.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import { InfoIcon } from "lucide-react";
import { Fragment } from "react";

export type {
  ConversationShareArtifactOpenAction,
  ConversationShareReadonlyTimelineProps,
} from "@/v4/share-readonly-timeline/types.js";

export function ConversationShareReadonlyTimeline(
  props: ConversationShareReadonlyTimelineProps,
) {
  return (
    <ZCodeIntlProvider initialLocale={props.locale ?? "zh-CN"}>
      <ConversationShareReadonlyTimelineContent {...props} />
    </ZCodeIntlProvider>
  );
}

function ConversationShareReadonlyTimelineContent({
  rows,
  contentBlocks,
  locale = "zh-CN",
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
  artifactUrls = EMPTY_ARTIFACT_URLS,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenFileLink,
  onOpenCodeViewer,
  artifactOpenAction,
  unsupportedRowCount = 0,
}: ConversationShareReadonlyTimelineProps) {
  const labels = useReadonlyLabels();
  const { toolSnapshots, blocks, envelopes, fallbacks, allUnits, units } =
    buildShareTimelineModel(rows, contentBlocks);
  const openShareExternalUrl = useOpenShareExternalUrl();
  const artifactOpenContext = useArtifactOpenContextValue({
    artifactWorkspaceRelativePaths,
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    onOpenFileLink,
    onOpenCodeViewer,
    artifactOpenAction,
  });
  return (
    <ToolSnapshotContext.Provider value={toolSnapshots}>
      <ToolPresentationCapabilitiesProvider
        value={{
          readonly: true,
          resourceUrl: (ref) => artifactUrls.get(ref),
          normalizeOutputText: (text) =>
            normalizeConversationShareMarkdown(text, artifactNames),
        }}
      >
        <TooltipProvider delayDuration={0}>
          <PluginReferenceIconProvider value={null}>
            <ArtifactOpenContext.Provider value={artifactOpenContext}>
              <div
                className="@container/conversation flex flex-col"
                data-conversation-share-timeline
              >
                {unsupportedRowCount > 0 ? (
                  // 中性信息语义，不用黄色 warning：分享本身没出错，只是这个 build 认不出其中几行。
                  <div
                    data-conversation-share-unsupported-notice="true"
                    className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
                  >
                    <InfoIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 break-words">
                      {labels.unsupportedRows}
                    </span>
                  </div>
                ) : null}
                {allUnits.map((original) => {
                  const unit = units.get(original.key);
                  const turnBlocks = blocks.filter(
                    (block) =>
                      block.product_turn_id ===
                        original.header?.productTurnId &&
                      !(
                        block.payload.unavailable &&
                        !block.payload.run &&
                        block.payload.artifacts.length === 0
                      ),
                  );
                  // 已知但隐藏的占位块仍认领摘要，避免删卡后占位文字又作为 fallback 出现。
                  const fallbackBlocks = envelopes.filter(
                    (block) =>
                      block.product_turn_id ===
                        original.header?.productTurnId &&
                      !blocks.some((known) => known.id === block.id),
                  );
                  return (
                    <Fragment key={original.key}>
                      {unit ? (
                        <ReadonlyTurn
                          unit={unit}
                          locale={locale}
                          theme={theme}
                          codePreviewSettings={codePreviewSettings}
                          artifactUrls={artifactUrls}
                          artifactNames={artifactNames}
                          labels={labels}
                          onOpenExternalUrl={openShareExternalUrl}
                        />
                      ) : null}
                      {turnBlocks.length ? (
                        <div className="min-w-0 px-4 pb-5 @md/conversation:px-6">
                          <ConversationShareContent
                            blocks={turnBlocks}
                            fallbacks={fallbacks}
                            artifactUrls={artifactUrls}
                            locale={locale}
                            onOpenResource={
                              artifactOpenContext && onOpenFileLink
                                ? (id) => {
                                    const path = workspacePath
                                      ? resolveImportedArtifactPath(
                                          workspacePath,
                                          artifactWorkspaceRelativePaths.get(
                                            id,
                                          ),
                                        )
                                      : null;
                                    if (path && workspacePath)
                                      onOpenFileLink({
                                        path,
                                        label: artifactNames.get(id) ?? path,
                                        workspacePath,
                                        workspaceIdentity,
                                        workspaceRemoteSessionId,
                                      });
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : null}
                      {fallbackBlocks.map((block) => (
                        <div
                          key={block.id}
                          className="px-4 pb-5 @md/conversation:px-6"
                          data-share-content-fallback={block.id}
                        >
                          <MessageResponse>
                            {fallbacks.get(block.fallback_row_id) ?? ""}
                          </MessageResponse>
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </ArtifactOpenContext.Provider>
          </PluginReferenceIconProvider>
        </TooltipProvider>
      </ToolPresentationCapabilitiesProvider>
    </ToolSnapshotContext.Provider>
  );
}
