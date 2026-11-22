import { z } from "zod";

/**
 * Профили глубины рассуждений (Инкремент 4.4).
 *
 * Живут в `@zcode/shared`, потому что их читают три слоя:
 * настройки (`validationAppSettings`), рантайм промпта (`apps/zcode-cli/packages/core`)
 * и будущий UI композера (Инкремент 4.6). Один enum на всех: расхождение значений
 * между схемой настроек и рантаймом привело бы к молчаливому сбросу на `standard`.
 */
export const PROMPT_DEPTH_PROFILES = ["standard", "deep", "max_reasoning"] as const;

export type PromptDepthProfile = (typeof PROMPT_DEPTH_PROFILES)[number];

export const DEFAULT_PROMPT_DEPTH_PROFILE: PromptDepthProfile = "standard";

/** Схема для настроек; тот же enum, что и в рантайме. */
export const promptDepthSchema = z.enum(PROMPT_DEPTH_PROFILES);

export function isPromptDepthProfile(value: unknown): value is PromptDepthProfile {
  return typeof value === "string" && (PROMPT_DEPTH_PROFILES as readonly string[]).includes(value);
}

/** Нормализует внешнее значение: неизвестное → `standard`, чтобы не ломать сборку промпта. */
export function resolvePromptDepthProfile(value: unknown): PromptDepthProfile {
  return isPromptDepthProfile(value) ? value : DEFAULT_PROMPT_DEPTH_PROFILE;
}
