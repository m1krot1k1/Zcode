import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  testId,
} from "@zcode/shared/test-ids";
import {
  WEEKDAY_ORDER,
  type CronBuilderState,
  type CustomRepeatUnit,
} from "@/settings/automationFormat.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { EndDatePicker } from "@/settings/automation-edit-view/AutomationEditCronPickers.js";
import {
  localDateEndTimestamp,
  toDateInputValue,
} from "@/settings/automation-edit-view/automationEditCronShared.js";

/** 自定义重复频率输入允许输入的视觉范围。 */
const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** cron 的步长必须为正整数，0 不能形成有效调度。 */
const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
const CUSTOM_REPEAT_INTERVAL_MAX = 200;

const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

export function CustomRepeatDialog({
  builder,
  endAt,
  intl,
  onConfirm,
  onOpenChange,
  open,
}: {
  builder: CronBuilderState;
  endAt: number | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onConfirm: (value: {
    interval: number;
    unit: CustomRepeatUnit;
    weekdays: number[];
    monthDays: number[];
    monthlyMode: CronBuilderState["customMonthlyMode"];
    endAt?: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [intervalInput, setIntervalInput] = useState(String(builder.customInterval));
  const [unit, setUnit] = useState<CustomRepeatUnit>(builder.customUnit);
  const [weekdays, setWeekdays] = useState(builder.customWeekdays);
  const [monthDays, setMonthDays] = useState(builder.customMonthDays);
  const [monthlyMode, setMonthlyMode] = useState(builder.customMonthlyMode);
  const [ends, setEnds] = useState(endAt !== undefined);
  const [endDate, setEndDate] = useState(toDateInputValue(endAt));

  useEffect(() => {
    if (!open) return;
    setIntervalInput(String(builder.customInterval));
    setUnit(builder.customUnit);
    setWeekdays(builder.customWeekdays);
    setMonthDays(builder.customMonthDays);
    setMonthlyMode(builder.customMonthlyMode);
    setEnds(endAt !== undefined);
    setEndDate(toDateInputValue(endAt));
  }, [builder, endAt, open]);

  const interval = Number(intervalInput);
  const isIntervalValid =
    /^\d+$/.test(intervalInput) &&
    Number.isInteger(interval) &&
    interval >= CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN &&
    interval <= CUSTOM_REPEAT_INTERVAL_MAX;
  const canIncrementInterval = intervalInput === "" || interval < CUSTOM_REPEAT_INTERVAL_MAX;
  const canDecrementInterval = intervalInput !== "" && interval > CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
  const stepInterval = (delta: 1 | -1) => {
    const currentInterval = /^\d+$/.test(intervalInput)
      ? interval
      : CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
    const nextInterval = Math.min(
      CUSTOM_REPEAT_INTERVAL_MAX,
      Math.max(CUSTOM_REPEAT_INTERVAL_INPUT_MIN, currentInterval + delta),
    );
    setIntervalInput(String(nextInterval));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-[400px] gap-0 overflow-y-auto border-border bg-card p-0 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)]"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className="text-ui-xl font-medium leading-[26px] tracking-[-0.12px]">
            {intl.formatMessage({ id: "automations.customRepeat.title" })}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 flex size-6 items-center justify-center rounded-[6px] opacity-80 transition-colors hover:bg-surface-hover hover:opacity-100"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-5 px-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-custom-interval"
              className="text-ui-base leading-5 tracking-[-0.18px] text-foreground"
            >
              {intl.formatMessage({ id: "automations.customRepeat.frequency" })}
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <Input
                  id="automation-custom-interval"
                  type="number"
                  min={CUSTOM_REPEAT_INTERVAL_INPUT_MIN}
                  max={CUSTOM_REPEAT_INTERVAL_MAX}
                  step={1}
                  inputMode="numeric"
                  value={intervalInput}
                  aria-invalid={!isIntervalValid}
                  className="h-9 rounded-lg px-3 pr-10 text-mobile-input-safe leading-6 tracking-[-0.18px] [appearance:textfield] md:text-ui-base md:leading-5 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_SELECT}
                  onChange={(event) => {
                    const value = event.target.value;
                    // number 输入允许空值和科学计数法；保留空值便于编辑，
                    // 但只接收非负整数文本，避免将无效值写进 cron / scheduleRule。
                    if (value === "" || /^\d+$/.test(value)) setIntervalInput(value);
                  }}
                />
                {/* 原生 number spinner 在系统浏览器与 WebView 的尺寸、主题反馈不一致；
                    使用受控步进按钮，统一桌面与手机 Web 的点击样式。 */}
                <div className="absolute inset-y-px right-px flex w-8 flex-col overflow-hidden rounded-r-[7px] border-l border-input-border bg-input">
                  <button
                    type="button"
                    aria-label="+1"
                    title="+1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}
                    disabled={!canIncrementInterval}
                    onClick={() => stepInterval(1)}
                    className="flex flex-1 items-center justify-center border-b border-input-border text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronUp className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    title="-1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}
                    disabled={!canDecrementInterval}
                    onClick={() => stepInterval(-1)}
                    className="flex flex-1 items-center justify-center text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <Select
                value={unit}
                onValueChange={(value) => {
                  const nextUnit = value as CustomRepeatUnit;
                  setUnit(nextUnit);
                  if (nextUnit === "yearly") setMonthDays([new Date().getDate()]);
                }}
              >
                <SelectTrigger
                  className="h-9 w-full rounded-[8px] px-3 text-ui-base leading-5 tracking-[-0.18px] hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                  data-testid={TID_AUTOMATION_CUSTOM_UNIT_SELECT}
                  indicator={<CustomRepeatSelectIndicator />}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                >
                  <SelectItem
                    value="minute"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "minute")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.minute",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="hourly"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "hourly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.hour",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="daily"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "daily")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.day",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="weekly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "weekly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.week",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="monthly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.month",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="yearly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.year",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {unit === "weekly" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_ORDER.map((day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      if (active && weekdays.length === 1) return;
                      setWeekdays(
                        active
                          ? weekdays.filter((candidate) => candidate !== day)
                          : [...weekdays, day],
                      );
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-md border text-ui-base",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    {intl.formatMessage({ id: `automations.weekday.${day}` })}
                  </button>
                );
              })}
            </div>
          ) : null}

          {unit === "monthly" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "automations.customRepeat.rule" })}
                </span>
                <Select
                  value={monthlyMode}
                  onValueChange={(value) =>
                    setMonthlyMode(value as CronBuilderState["customMonthlyMode"])
                  }
                >
                  <SelectTrigger
                    className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                    indicator={<CustomRepeatSelectIndicator />}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                  >
                    <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byDate",
                      })}
                    </SelectItem>
                    <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byWeekday",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {monthlyMode === "date" ? (
                <div className="grid grid-cols-10 gap-2.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
                    const active = monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          if (active && monthDays.length === 1) return;
                          setMonthDays(
                            active
                              ? monthDays.filter((candidate) => candidate !== day)
                              : [...monthDays, day],
                          );
                        }}
                        className={cn(
                          "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAY_ORDER.map((day) => {
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays([day])}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-md border text-ui-base",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {intl.formatMessage({
                          id: `automations.weekday.${day}`,
                        })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base leading-5 tracking-[-0.18px] text-foreground">
              {intl.formatMessage({ id: "automations.customRepeat.ends" })}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setEnds(false)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      !ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {!ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.neverEnds",
                })}
              </button>
              <button
                type="button"
                onClick={() => setEnds(true)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.endsOption",
                })}
              </button>
            </div>
            {/* 修复原因：原生 date input 会在暗色主题中弹出不可控的系统白色月历。 */}
            <EndDatePicker
              value={endDate}
              min={toDateInputValue(Date.now())}
              disabled={!ends}
              intl={intl}
              onChange={setEndDate}
            />
          </div>
        </div>

        <DialogFooter className="gap-3 px-5 pb-5 pt-5">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:border-border-hover hover:bg-input/50"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:bg-primary/80"
            data-testid={TID_AUTOMATION_CUSTOM_CONFIRM}
            disabled={!isIntervalValid || (ends && !localDateEndTimestamp(endDate))}
            onClick={() => {
              onConfirm({
                interval,
                unit,
                weekdays,
                monthDays,
                monthlyMode,
                ...(ends ? { endAt: localDateEndTimestamp(endDate) } : {}),
              });
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "common.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
