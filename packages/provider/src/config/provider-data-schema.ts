import { z } from "zod";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
  "opencode-sdk",
  "cursor-cli",
]);

/** CLI-провайдеры работают только через локальный бинарь: без endpoint и headers. */
const localCliApiTypes = new Set<string>(["opencode-sdk", "cursor-cli"]);
export function isLocalCliApiType(type: string | null | undefined): boolean {
  return type != null && localCliApiTypes.has(type);
}
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
export const zhipuAccountModeDataSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  // 加速卡访问类别；与 zcodeProviderAccountAccessSchema.mode 同值，改动需同步两处。
  "highspeed",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

export const apiKeyAccessDataSchema = z
  .object({
    type: z.enum(["api-key", "zhipu-coding-plan-api-key"]),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
  })
  .strict();
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.extend({
  apiKey: nonBlankRequiredString,
});

export const localAuthAccessDataSchema = z.object({ type: z.literal("local-auth") }).strict();

export const completeZhipuAccountAccessDataSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: zhipuAccountModeDataSchema,
    entitled: z.boolean(),
  })
  .strict();
export const zhipuAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeZhipuAccountAccessDataSchema.shape),
    type: completeZhipuAccountAccessDataSchema.shape.type,
  })
  .strict();
export const providerAccessDataSchema = z.discriminatedUnion("type", [
  apiKeyAccessDataSchema,
  localAuthAccessDataSchema,
  zhipuAccountAccessDataSchema,
]);
const completeProviderAccessDataSchema = z.discriminatedUnion("type", [
  completeApiKeyAccessDataSchema,
  localAuthAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
]);export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: z.string().url().nullable().optional(),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict()
  .superRefine((api, context) => validateProviderApiShape(api, context, true));
export const providerApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema.nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict()
  .superRefine((api, context) => validateProviderApiShape(api, context, false));
// Personal 允许暂存编辑中的 endpoint；完整 schema 仍拒绝，且只影响该 Provider 的准入。
export const personalProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema.nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict()
  .superRefine((api, context) => validateProviderApiShape(api, context, false));

function validateProviderApiShape(
  api: {
    type?: string | null;
    baseUrl?: string | null;
    headers?: Readonly<Record<string, string>> | null;
  },
  context: z.RefinementCtx,
  requireEndpoint: boolean,
): void {
  if (isLocalCliApiType(api.type)) {
    if (api.baseUrl !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: `${api.type} 不使用 endpoint`,
      });
    }
    if (api.headers !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: `${api.type} 不使用 headers`,
      });
    }
    return;
  }
  if (requireEndpoint && api.type != null && api.baseUrl == null) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "缺少必填配置 baseUrl",
      params: { configIssueCode: "required-field-missing" },
    });
  }
}

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
export const providerConfigDataObjectSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const providerConfigDataSchema = providerConfigDataObjectSchema.superRefine(
  validateLocalAuthRuntimePair,
);
export const completeProviderConfigDataSchema = z
  .object({
    group: providerGroupDataSchema,
    logo: providerLogoDataSchema.nullable().optional(),
    access: completeProviderAccessDataSchema,
    api: completeProviderApiDataSchema,
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict()
  .superRefine(validateLocalAuthRuntimePair);

export function validateLocalAuthRuntimePair(
  config: {
    access?: { type?: string | null } | null;
    api?: { type?: string | null } | null;
  },
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[] = [],
): void {
  const localAuth = config.access?.type === "local-auth";
  const localCliApi = isLocalCliApiType(config.api?.type);
  if (localAuth === localCliApi) return;
  context.addIssue({
    code: "custom",
    path: [...pathPrefix, localAuth ? "api" : "access"],
    message: "local-auth 与 opencode-sdk/cursor-cli 必须成对使用",
  });
}

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    deprecated: z.boolean().optional(),
    config: providerConfigDataSchema,
  })
  .strict();
