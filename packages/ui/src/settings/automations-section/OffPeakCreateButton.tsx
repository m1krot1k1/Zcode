/**
 * 「闲时任务」创建按钮：禁用态需要把 tooltip 挂到可指针的外层包裹元素上。
 */
import { TID_OFFPEAK_CREATE_BUTTON } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  type OffPeakCreateBlockReason,
} from "@/settings/offPeakUiPresentation.js";

export function OffPeakCreateButton({
  greyReason,
  greyTooltip,
  onCreate,
}: {
  greyReason: OffPeakCreateBlockReason | null;
  greyTooltip?: string;
  onCreate: () => void;
}) {
  const { intl } = useZCodeIntl();
  // disabled 按钮 pointer-events-none，tooltip 必须挂在外层可指针元素上。
  const button = (
    <Button
      type="button"
      variant="default"
      size="default"
      data-testid={TID_OFFPEAK_CREATE_BUTTON}
      disabled={greyReason !== null}
      onClick={onCreate}
    >
      {intl.formatMessage({ id: "offPeak.createButton" })}
    </Button>
  );

  if (!greyTooltip) return button;
  return (
    <ControlHintTooltip
      title={greyTooltip}
      side="top"
      align="center"
      className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
    >
      <span className="inline-flex">{button}</span>
    </ControlHintTooltip>
  );
}
