/**
 * Инлайн-обратный отсчёт Highspeed-карты в тулбаре.
 *
 * Вынесен из V4ComposerToolbar.tsx без изменения разметки: собственный
 * секундный таймер и aria/title-подписи остаются локальными для компонента.
 */
import { useEffect, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import { formatHighspeedRemainingTime } from "@/highspeed/highspeedTime.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function HighspeedCountdown({ expiresAt }: { expiresAt: number }) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingTime = formatHighspeedRemainingTime(expiresAt, now);
  const absoluteExpiryLabel = intl.formatMessage(
    { id: "chat.highspeed.expiresAt" },
    {
      time: new Date(expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  );
  const remainingTimeLabel = intl.formatMessage(
    { id: "chat.highspeed.remainingTime" },
    { time: remainingTime },
  );

  // Bug 根因：倒计时原先晚于 Think 折叠，在中等窄窗口继续占用固定 82px；
  // 窄窗口只收起数值，保留可 hover 的时钟入口。
  return (
    <span
      aria-label={absoluteExpiryLabel}
      title={remainingTimeLabel}
      data-highspeed-countdown="true"
      className="highspeed-inline-countdown inline-flex h-7 w-[82px] shrink-0 items-center justify-center gap-1 rounded-md p-1 text-ui-caption @max-xl/composer:w-7 @max-xl/composer:gap-0 @max-xl/composer:p-0"
    >
      <AlarmClockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        data-highspeed-countdown-value="true"
        className="relative h-[18px] w-[54px] shrink-0 leading-4 tabular-nums @max-xl/composer:hidden"
      >
        <span className="absolute left-0 top-0.5">{remainingTime}</span>
      </span>
    </span>
  );
}
