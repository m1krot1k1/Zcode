/**
 * 首页模板区：闲时任务模板（灰度命中）与定时任务模板（Client Scenes 候选目录）。
 *
 * 点击只负责预填创建表单，具体路由与埋点由父层回调决定。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveAutomationTemplateText,
  resolveOffPeakTemplateText,
  type OffPeakAutomationTemplate,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";
import { AutomationTemplateSkeletonGrid } from "@/settings/AutomationTemplateSkeletonGrid.js";
import { OffPeakTemplateIcon } from "@/settings/OffPeakTemplateIcon.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";

export interface OffPeakTemplateSectionProps {
  loading: boolean;
  templates: readonly OffPeakAutomationTemplate[];
  planLocked: boolean;
  onCodingPlanRequired: () => void;
  onSelectTemplate: (template: OffPeakAutomationTemplate) => void;
}

export function OffPeakTemplateSection({
  loading,
  templates,
  planLocked,
  onCodingPlanRequired,
  onSelectTemplate,
}: OffPeakTemplateSectionProps) {
  const { intl, locale } = useZCodeIntl();
  return (
    <section
      data-automations-idle-templates
      aria-busy={loading}
      className="flex w-full flex-col gap-4"
    >
      <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.templates.sectionTitle" })}
      </h2>
      {loading ? (
        <AutomationTemplateSkeletonGrid label={intl.formatMessage({ id: "common.loading" })} />
      ) : templates.length === 0 ? (
        <div
          data-automation-template-empty-state
          className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
        >
          {intl.formatMessage({ id: "automations.templates.unavailable" })}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
          {templates.map((template) => {
            const card = (
              <button
                type="button"
                onClick={() => {
                  if (planLocked) {
                    onCodingPlanRequired();
                    return;
                  }
                  onSelectTemplate(template);
                }}
                // Grid wrapper 虽已拉伸到行高，卡片本体仍需 h-full 才能继承同一行的最大高度；只设 min-height 时短文案卡会矮一截。
                className="flex h-full min-h-[114px] w-full flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <div className="flex items-center gap-0.5 text-foreground">
                  <OffPeakTemplateIcon
                    className="size-4 shrink-0"
                    iconName={template.iconName}
                    name={template.icon}
                  />
                  <span className="truncate px-1 text-ui-base font-medium leading-5 text-foreground">
                    {resolveOffPeakTemplateText(template, "title", locale, intl.formatMessage)}
                  </span>
                </div>
                <p className="text-wrap-phrase line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {resolveOffPeakTemplateText(template, "description", locale, intl.formatMessage)}
                </p>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "offPeak.form.soonestAvailable",
                  })}
                </div>
              </button>
            );
            return (
              <div key={template.id} className="h-full">
                {card}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export interface ScheduledTemplateSectionProps {
  loading: boolean;
  templates: readonly ScheduledAutomationTemplate[];
  onSelectTemplate: (template: ScheduledAutomationTemplate) => void;
}

export function ScheduledTemplateSection({
  loading,
  templates,
  onSelectTemplate,
}: ScheduledTemplateSectionProps) {
  const { intl, locale } = useZCodeIntl();
  return (
    <section
      data-automations-scheduled-templates
      aria-busy={loading}
      className="flex w-full flex-col gap-4"
    >
      <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "automations.moreIdeas" })}
      </h2>
      {loading ? (
        <AutomationTemplateSkeletonGrid label={intl.formatMessage({ id: "common.loading" })} />
      ) : templates.length === 0 ? (
        <div
          data-automation-template-empty-state
          className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
        >
          {intl.formatMessage({ id: "automations.templates.unavailable" })}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {templates.map((template) => {
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelectTemplate(template)}
                className="group flex min-h-[114px] flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <div className="flex min-w-0 items-center gap-1 text-foreground">
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <AutomationScheduledTemplateIcon
                      iconName={template.iconName}
                      name={template.icon}
                    />
                  </span>
                  <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                    {resolveAutomationTemplateText(template.title, locale)}
                  </span>
                </div>
                {/* Bug 原因：定时模板首次实现时把周期时间拼进标题行，和闲时模板的底部时间层级不一致。 */}
                <p className="line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {resolveAutomationTemplateText(template.description, locale)}
                </p>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {describeAutomationCardSchedule({ cronExpr: template.cronExpr }, intl)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
