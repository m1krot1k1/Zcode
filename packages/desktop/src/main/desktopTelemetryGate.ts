/**
 * Единый выключатель телеметрии рабочего процесса.
 *
 * Причина: opt-out проверялся только в HTTP-отправке `/event/report`, а ARMS RUM
 * (`sendCustom`/`sendEvent`, включая краш-репорты) уходил всегда. Здесь хранится
 * последнее известное значение настройки, чтобы синхронный reporter мог решить,
 * отправлять ли событие, не дожидаясь запроса к хранилищу.
 */
let telemetryAllowed = true;

export function setDesktopTelemetryAllowed(allowed: boolean): void {
  telemetryAllowed = allowed;
}

/** `DO_NOT_TRACK` — жёсткий выключатель независимо от настройки приложения. */
export function isDoNotTrackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DO_NOT_TRACK?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isDesktopTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return telemetryAllowed && !isDoNotTrackEnabled(env);
}
