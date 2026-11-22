import type { ReactNode } from "react";
import { ChevronRight, LoaderCircle, MessagesSquare } from "lucide-react";
import type { ConversationShareAccessMode } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationSharePermissionPicker } from "@/ConversationSharePermissionPicker.js";

export interface ConversationShareEditSectionProps {
  title: string;
  onTitleChange: (title: string) => void;
  selectionEditing: boolean;
  preflightChecking: boolean;
  preflightContent?: ReactNode;
  onEditSelection: () => void;
  selectedCount: number;
  totalCount: number;
  accessMode: ConversationShareAccessMode;
  onAccessModeChange: (accessMode: ConversationShareAccessMode) => void;
}

/** 分享标题、范围入口与可见性选择；preflight 结果由宿主渲染在范围入口下方。 */
export function ConversationShareEditSection({
  title,
  onTitleChange,
  selectionEditing,
  preflightChecking,
  preflightContent,
  onEditSelection,
  selectedCount,
  totalCount,
  accessMode,
  onAccessModeChange,
}: ConversationShareEditSectionProps) {
  const { intl } = useZCodeIntl();

  return (
    <div className={cn("grid px-3", "gap-3")}>
      <label className={cn("grid gap-1 text-foreground-subtle", "text-ui-base")}>
        {intl.formatMessage({ id: "conversationShare.shareTitle" })}
        <Input
          size="lg"
          value={title}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
          className={undefined}
        />
      </label>
      <div className="grid gap-1 text-ui-base">
        <span className="text-foreground-subtle">
          {intl.formatMessage({
            id: "conversationShare.range.label",
          })}
        </span>
        <Button
          size="lg"
          variant="outline"
          onClick={onEditSelection}
          disabled={selectionEditing}
          data-testid="conversation-share-adjust"
          aria-expanded={selectionEditing}
          aria-busy={preflightChecking}
          className="w-full justify-start gap-2 border-input-border bg-input pl-3 pr-2 font-normal hover:border-input-border-hover"
        >
          {preflightChecking ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-foreground-subtle"
              aria-hidden="true"
            />
          ) : (
            <MessagesSquare className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          )}
          <span
            className="min-w-0 flex-1 truncate text-left"
            data-testid="conversation-share-range-summary"
          >
            {preflightChecking
              ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
              : intl.formatMessage(
                  {
                    id:
                      selectedCount === totalCount
                        ? "conversationShare.range.all"
                        : "conversationShare.range.selected",
                  },
                  { count: selectedCount },
                )}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        </Button>
        {preflightContent}
      </div>
      <ConversationSharePermissionPicker
        permission={
          accessMode === "public_readonly"
            ? "link-viewer"
            : accessMode === "public_importable"
              ? "link-editor"
              : "private"
        }
        onChange={(permission) =>
          onAccessModeChange(
            permission === "link-viewer"
              ? "public_readonly"
              : permission === "link-editor"
                ? "public_importable"
                : "private",
          )
        }
      />
    </div>
  );
}
