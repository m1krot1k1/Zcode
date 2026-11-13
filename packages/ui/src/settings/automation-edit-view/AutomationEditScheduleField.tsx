import type { Dispatch, SetStateAction } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { ZCodeAutomation } from "@zcode/shared";
import {
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  testId,
} from "@zcode/shared/test-ids";
import {
  AutomationAddScheduleIcon,
  AutomationChevronDownIcon,
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatGmtOffset,
  type CronBuilderState,
  type CronFrequency,
} from "@/settings/automationFormat.js";
import { logger } from "@/logger.js";
import type { AutomationEditDirtyField } from "@/settings/automationEditDirtyState.js";
import type { AutomationEditRequiredField } from "@/settings/automationEditValidation.js";
import {
  MonthDayPicker,
  TimeOfDayPicker,
  WeekdayPicker,
} from "@/settings/automation-edit-view/AutomationEditCronPickers.js";
import { CustomRepeatDialog } from "@/settings/automation-edit-view/AutomationEditCustomRepeatDialog.js";
import { pad2 } from "@/settings/automation-edit-view/automationEditCronShared.js";

const FREQUENCIES: CronFrequency[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);

interface AutomationEditScheduleFieldProps {
  builder: CronBuilderState;
  setBuilder: Dispatch<SetStateAction<CronBuilderState>>;
  clearRequiredFieldValidation: (field: AutomationEditRequiredField) => void;
  customRepeatOpen: boolean;
  editing: ZCodeAutomation | null;
  endAt: number | undefined;
  handleRemoveSchedule: () => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  markFieldTouched: (field: AutomationEditDirtyField) => void;
  preserveSessionCreatedSchedule: boolean;
  schedulePreview: string;
  scheduleRemoved: boolean;
  setCustomRepeatOpen: Dispatch<SetStateAction<boolean>>;
  setEndAt: (endAt: number | undefined) => void;
  setScheduleRemoved: Dispatch<SetStateAction<boolean>>;
  validationErrors: ReadonlySet<AutomationEditRequiredField>;
}

export function AutomationEditScheduleField({
  builder,
  setBuilder,
  clearRequiredFieldValidation,
  customRepeatOpen,
  editing,
  endAt,
  handleRemoveSchedule,
  intl,
  markFieldTouched,
  preserveSessionCreatedSchedule,
  schedulePreview,
  scheduleRemoved,
  setCustomRepeatOpen,
  setEndAt,
  setScheduleRemoved,
  validationErrors,
}: AutomationEditScheduleFieldProps) {
  return (
    <>
      {/* 会话来源的旧 cron 无法可靠回显；删除后切换到标准 UI 调度编辑流程。 */}
      {preserveSessionCreatedSchedule ? (
        <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
          <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
            {intl.formatMessage({
              id: "automations.form.schedule.label",
            })}
          </label>
          <div
            data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
            className="relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input px-2 pr-9 text-ui-base leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
          >
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "automations.frequency.custom" })}
            </span>
            <button
              type="button"
              data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
              onClick={handleRemoveSchedule}
              className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
              aria-label={intl.formatMessage({ id: "common.delete" })}
            >
              <AutomationTrashIcon />
            </button>
          </div>
        </div>
      ) : (
        <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
          <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
            {intl.formatMessage({
              id: "automations.form.schedule.label",
            })}
          </label>
          {scheduleRemoved ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid={TID_AUTOMATION_SCHEDULE_ADD}
                  aria-invalid={scheduleRemoved && validationErrors.has("schedule")}
                  className={cn(
                    "flex h-9 w-full items-center gap-1 rounded-xl border bg-input px-2 text-ui-base font-normal leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover hover:text-foreground focus-visible:border-input-border-focused focus-visible:bg-input-focused data-[state=open]:border-input-border-focused data-[state=open]:bg-input-focused data-[state=open]:text-foreground",
                    validationErrors.has("schedule")
                      ? "!border-destructive !ring-2 !ring-destructive/20"
                      : "border-input-border",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <AutomationAddScheduleIcon aria-hidden="true" />
                  </span>
                  {intl.formatMessage({
                    id: "scheduledPreview.addSchedule",
                  })}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={4} className="w-[148px] p-1.5">
                {FREQUENCIES.map((frequency) => (
                  <DropdownMenuItem
                    key={frequency}
                    data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, frequency)}
                    // raw 白色 5% 只在深色菜单可见，Light 下高亮状态近似透明。
                    className="min-h-8 px-2 py-2 text-ui-base text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground"
                    onSelect={() => {
                      markFieldTouched("schedule");
                      if (frequency === "custom") {
                        setCustomRepeatOpen(true);
                        return;
                      }
                      setBuilder((previous) => ({
                        ...previous,
                        frequency,
                        ...(frequency === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                      }));
                      setScheduleRemoved(false);
                      clearRequiredFieldValidation("schedule");
                    }}
                  >
                    {intl.formatMessage({
                      id: `automations.frequency.${frequency}`,
                    })}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              {/* Bugfix：调度栏原先使用 min-height、换行布局和全行摘要，新增 tag 后会被第二行撑高。
                        恢复全局 Input 的 1px 描边后，用 7px 左内边距抵消边框占位，保持首个 tag
                        距外边缘仍为 8px；tag 增加上下各 1px padding 后仍在 36px input 内垂直居中。 */}
              <div className="relative flex h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border border-input-border bg-input py-1 pl-[7px] pr-9 text-ui-base leading-5 text-foreground transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
                <Select
                  value={builder.frequency}
                  onValueChange={(value) => {
                    // Radix Select 在编辑旧 cron 的控件注册阶段可能发出空值，不能覆盖已解析频率。
                    if (!isCronFrequency(value)) {
                      logger.warn("[AutomationEditView] 忽略非法的频率选择值", {
                        automationId: editing?.automationId,
                        cronExpr: editing?.cronExpr,
                        value,
                      });
                      return;
                    }
                    markFieldTouched("schedule");
                    if (value === "custom") {
                      setCustomRepeatOpen(true);
                      return;
                    }
                    setBuilder((prev) => ({
                      ...prev,
                      frequency: value,
                      ...(value === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                    }));
                  }}
                >
                  {/* 修复原因：频率触发器曾写死深色值，导致浅色主题下对比失真；
                            改用 hover/selected 语义 token，并在 20px 行高外增加上下各 1px padding。 */}
                  <SelectTrigger
                    variant="ghost"
                    data-testid={TID_AUTOMATION_FREQUENCY_SELECT}
                    className="h-auto min-w-24 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                    indicator={<AutomationChevronDownIcon />}
                  >
                    <SelectValue>
                      {intl.formatMessage({
                        id: `automations.frequency.${builder.frequency}`,
                      })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((freq) => (
                      <SelectItem
                        key={freq}
                        value={freq}
                        data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, freq)}
                      >
                        {intl.formatMessage({
                          id: `automations.frequency.${freq}`,
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {builder.frequency === "monthly" ? (
                  <Select
                    value={String(builder.dayOfMonth)}
                    onValueChange={(value) => {
                      markFieldTouched("schedule");
                      setBuilder((prev) => ({
                        ...prev,
                        dayOfMonth: Number(value),
                      }));
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      className="h-auto w-auto rounded-full border-0 bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                      indicator={<AutomationChevronDownIcon />}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {intl.formatMessage(
                            { id: "automations.form.dayOfMonth" },
                            { day: String(day) },
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                {builder.frequency === "weekly" ? (
                  <WeekdayPicker
                    weekdays={builder.weekdays}
                    intl={intl}
                    onChange={(weekdays) => {
                      markFieldTouched("schedule");
                      setBuilder((prev) => ({ ...prev, weekdays }));
                    }}
                  />
                ) : null}

                {/* Bugfix：重复周期曾写死 #F8F8F8 且三段 tag 圆角不一致；统一语义文字色与 pill 圆角。 */}
                {builder.frequency === "custom" ? (
                  <button
                    type="button"
                    // 视觉重构误删了 E2E 稳定选择器，导致保存后无法重新打开 Custom Repeat 验证复原值。
                    data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}
                    onClick={() => setCustomRepeatOpen(true)}
                    className="inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected"
                  >
                    <span>
                      {intl.formatMessage(
                        {
                          id: "automations.customRepeat.compactFrequency",
                        },
                        {
                          interval: String(builder.customInterval),
                          unit: intl.formatMessage({
                            id: `automations.customRepeat.unit.${
                              builder.customUnit === "minute"
                                ? "minute"
                                : builder.customUnit === "daily"
                                  ? "day"
                                  : builder.customUnit === "weekly"
                                    ? "week"
                                    : builder.customUnit === "monthly"
                                      ? "month"
                                      : builder.customUnit === "yearly"
                                        ? "year"
                                        : "hour"
                            }`,
                          }),
                        },
                      )}
                    </span>
                    <AutomationChevronDownIcon />
                  </button>
                ) : null}

                {builder.frequency !== "custom" && builder.frequency !== "hourly" ? (
                  <>
                    {/* 修复原因：连接词曾单独使用二级色，和相邻 tag 主文字形成错误的高亮断层。 */}
                    <span className="text-foreground">
                      {intl.formatMessage({
                        id: "automations.form.schedule.at",
                      })}
                    </span>
                    <TimeOfDayPicker
                      hour={builder.hour}
                      minute={builder.minute}
                      ariaLabel={intl.formatMessage({
                        id: "automations.form.schedule.label",
                      })}
                      onChange={(hour, minute) => {
                        markFieldTouched("schedule");
                        setBuilder((prev) => ({ ...prev, hour, minute }));
                      }}
                    />
                    <span className="whitespace-nowrap text-foreground-subtle">
                      {formatGmtOffset()}
                    </span>
                  </>
                ) : null}

                {builder.frequency === "hourly" ? (
                  <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                    <span>
                      {intl.formatMessage({
                        id: "automations.form.schedule.minutePrefix",
                      })}
                    </span>
                    <Select
                      value={String(builder.minute)}
                      onValueChange={(value) => {
                        markFieldTouched("schedule");
                        setBuilder((prev) => ({
                          ...prev,
                          minute: Number(value),
                        }));
                      }}
                    >
                      <SelectTrigger
                        variant="ghost"
                        className="h-auto w-14 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                      >
                        <SelectValue>{pad2(builder.minute)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {Array.from({ length: 60 }, (_, value) => (
                          <SelectItem key={value} value={String(value)}>
                            {pad2(value)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span>
                      {intl.formatMessage({
                        id: "automations.form.schedule.minuteSuffix",
                      })}
                    </span>
                  </div>
                ) : null}

                {builder.frequency === "custom" && builder.customUnit === "hourly" ? (
                  <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                    <span>
                      {intl.formatMessage({
                        id: "automations.form.schedule.at",
                      })}
                    </span>
                    <Select
                      value={String(builder.minute)}
                      onValueChange={(value) => {
                        markFieldTouched("schedule");
                        setBuilder((prev) => ({
                          ...prev,
                          minute: Number(value),
                        }));
                      }}
                    >
                      <SelectTrigger
                        variant="ghost"
                        className="h-auto w-16 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                      >
                        <SelectValue>{pad2(builder.minute)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {Array.from({ length: 60 }, (_, value) => (
                          <SelectItem key={value} value={String(value)}>
                            {pad2(value)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span>
                      {intl.formatMessage({
                        id: "automations.customRepeat.minutes",
                      })}
                    </span>
                  </div>
                ) : null}

                {builder.frequency === "custom" && builder.customUnit === "yearly" ? (
                  <MonthDayPicker
                    month={builder.customMonth}
                    day={builder.customMonthDays[0] ?? 1}
                    intl={intl}
                    onChange={(month, day) => {
                      markFieldTouched("schedule");
                      setBuilder((prev) => ({
                        ...prev,
                        customMonth: month,
                        customMonthDays: [day],
                      }));
                    }}
                  />
                ) : null}

                {builder.frequency === "custom" &&
                builder.customUnit !== "hourly" &&
                builder.customUnit !== "minute" ? (
                  <>
                    <span className="text-foreground">
                      {intl.formatMessage({
                        id: "automations.form.schedule.at",
                      })}
                    </span>
                    <TimeOfDayPicker
                      hour={builder.hour}
                      minute={builder.minute}
                      onChange={(hour, minute) => {
                        markFieldTouched("schedule");
                        setBuilder((prev) => ({ ...prev, hour, minute }));
                      }}
                    />
                    <span className="text-foreground-subtle">{formatGmtOffset()}</span>
                  </>
                ) : null}

                {schedulePreview ? (
                  <span
                    data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                    className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle sm:ml-1"
                  >
                    {schedulePreview}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                  onClick={handleRemoveSchedule}
                  className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                >
                  <AutomationTrashIcon />
                </button>
              </div>
            </>
          )}

          <CustomRepeatDialog
            builder={builder}
            endAt={endAt}
            intl={intl}
            open={customRepeatOpen}
            onOpenChange={setCustomRepeatOpen}
            onConfirm={({ interval, unit, weekdays, monthDays, monthlyMode, endAt: nextEndAt }) => {
              markFieldTouched("schedule");
              setScheduleRemoved(false);
              clearRequiredFieldValidation("schedule");
              setBuilder((prev) => ({
                ...prev,
                frequency: "custom",
                customInterval: interval,
                customUnit: unit,
                customWeekdays: weekdays,
                customMonthDays: monthDays,
                customMonthlyMode: monthlyMode,
              }));
              setEndAt(nextEndAt);
            }}
          />
        </div>
      )}
    </>
  );
}
