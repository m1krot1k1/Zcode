import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { memo, useMemo } from "react";

export const AssistantTextPresentation = memo(
  function AssistantTextPresentation({
    row,
    theme,
    codePreviewSettings,
    artifactNames,
    onOpenExternalUrl,
  }: {
    row: AssistantTextRow;
    theme: Theme;
    codePreviewSettings: CodePreviewSettings;
    artifactNames: ReadonlyMap<string, string>;
    onOpenExternalUrl: (url: string) => void;
  }) {
    const markdown = useMemo(
      () => normalizeConversationShareMarkdown(row.text, artifactNames),
      [artifactNames, row.text],
    );
    return (
      <div
        data-conversation-share-row-kind="assistantText"
        className="group/assistant-row"
      >
        <div
          data-conversation-selectable="true"
          className="w-full text-ui-base"
        >
          <MessageResponse
            streaming={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            renderZCodeFileCitations={false}
            onOpenExternalUrl={onOpenExternalUrl}
          >
            {markdown}
          </MessageResponse>
        </div>
      </div>
    );
  },
);
