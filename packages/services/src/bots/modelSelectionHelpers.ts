import { type ZCodeProvider } from "@zcode/shared";

const BOT_NATIVE_MODEL_PROVIDER_PREFIX = "native:";

function resolveTaskModel(model: string | undefined): string | undefined {
  return model && model !== "default" ? model : undefined;
}

export function getNativeModelProviderId(zcodeProvider: ZCodeProvider): string {
  return `${BOT_NATIVE_MODEL_PROVIDER_PREFIX}${zcodeProvider}`;
}
