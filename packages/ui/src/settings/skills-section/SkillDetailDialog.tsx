/** 技能详情弹窗：描述、元数据与可打开的 SKILL.md 路径。 */
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SkillDetailDialogProps } from "@/settings/skills-section/types.js";

function SkillDetailField({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  if (!value) {
    return null;
  }
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div
        className={[
          "mt-1 break-words text-ui-base text-foreground-subtle",
          mono ? "break-all font-mono" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function SkillPathDetailField({
  label,
  path,
  openLabel,
  onOpen,
}: {
  label: string;
  path: string;
  openLabel: string;
  onOpen: () => void;
}) {
  return (
    <div className="min-w-0 col-span-2">
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div className="mt-1">
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-label={openLabel}
          title={openLabel}
          className="inline-flex h-auto max-w-full items-baseline gap-1.5 whitespace-normal break-all px-0 py-0 text-left align-baseline font-mono text-ui-base font-normal text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
          onClick={onOpen}
        >
          <span>{path}</span>
          <ExternalLink
            className="relative top-px size-3 shrink-0"
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
}

export function SkillDetailDialog({
  skill,
  scopeLabel,
  publishedAt,
  onClose,
  onOpenPath,
}: SkillDetailDialogProps) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog
      open={skill !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[min(80vh,640px)] max-w-xl overflow-hidden p-0">
        {skill ? (
          <div className="flex min-h-0 flex-col">
            <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
              <DialogTitle className="truncate pr-8 text-ui-lg">
                {skill.name}
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 space-y-4 overflow-auto px-4 py-5">
              <div className="grid gap-1.5">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "settings.skills.detail.description",
                  })}
                </div>
                <div className="max-h-40 overflow-auto whitespace-pre-wrap text-ui-base/relaxed text-foreground-subtle">
                  {skill.description ||
                    intl.formatMessage({
                      id: "settings.skills.noDescription",
                    })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.scope",
                  })}
                  value={scopeLabel}
                />
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.status",
                  })}
                  value={
                    skill.enabled
                      ? intl.formatMessage({
                          id: "settings.skills.detail.enabled",
                        })
                      : intl.formatMessage({
                          id: "settings.skills.detail.disabled",
                        })
                  }
                />
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.version",
                  })}
                  value={skill.metadata?.version}
                  mono
                />
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.slug",
                  })}
                  value={skill.metadata?.slug}
                  mono
                />
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.publishedAt",
                  })}
                  value={publishedAt}
                  mono
                />
                <SkillDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.ownerId",
                  })}
                  value={skill.metadata?.ownerId}
                  mono
                  className="col-span-2"
                />
                <SkillPathDetailField
                  label={intl.formatMessage({
                    id: "settings.skills.detail.path",
                  })}
                  path={skill.path}
                  openLabel={intl.formatMessage({
                    id: "settings.skills.detail.openPath",
                  })}
                  onOpen={() => onOpenPath(skill.path)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
