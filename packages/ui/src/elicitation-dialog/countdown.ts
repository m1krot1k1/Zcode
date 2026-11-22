import { useEffect, useState } from "react";
import type { InteractionAutoResolution } from "@zcode/shared/zcode-protocol-v4";

const ELICITATION_FINAL_MINUTE_MS = 60_000;

export function getElicitationCountdownSeconds(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0 || remainingMs >= ELICITATION_FINAL_MINUTE_MS) return null;
  return Math.max(1, Math.floor(remainingMs / 1_000));
}

function getElicitationCountdownRefreshDelay(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0) return null;
  if (remainingMs >= ELICITATION_FINAL_MINUTE_MS) {
    return remainingMs - (ELICITATION_FINAL_MINUTE_MS - 1);
  }
  const seconds = Math.max(1, Math.floor(remainingMs / 1_000));
  if (seconds <= 1) return remainingMs;
  return Math.max(1, remainingMs - (seconds * 1_000 - 1));
}

export function useElicitationCountdownSeconds(
  autoResolution: InteractionAutoResolution | undefined,
) {
  const [clockNow, setClockNow] = useState(Date.now);

  useEffect(() => {
    if (!autoResolution || autoResolution.state === "snoozed") return;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      const now = Date.now();
      setClockNow(now);
      if (document.visibilityState === "hidden") return;
      const delay = getElicitationCountdownRefreshDelay(autoResolution, now);
      if (delay !== null) {
        timeoutId = window.setTimeout(schedule, delay);
      }
    };
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [
    autoResolution?.state,
    autoResolution?.startedAt,
    autoResolution?.state === "snoozed" ? autoResolution.snoozedAt : autoResolution?.deadlineAt,
  ]);

  return getElicitationCountdownSeconds(autoResolution, clockNow);
}
