import { z } from "zod";
import { nonEmptyString } from "./schema-core.js";

/** Strict CLI -> process-owning Host bridge for one explicitly delegated OpenCode ACP run. */
const zcodeOpenCodeAgentRunIdentitySchema = z
  .object({
    protocolVersion: z.literal(1),
    zcodeSessionId: nonEmptyString.max(256),
    commandId: nonEmptyString.max(256),
    runId: nonEmptyString.max(256),
  })
  .strict();

export const zcodeOpenCodeAgentRunRequestSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...zcodeOpenCodeAgentRunIdentitySchema.shape,
        operation: z.literal("startRun"),
        text: z
          .string()
          .min(1)
          .max(64 * 1024),
        model: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("default") }).strict(),
          z
            .object({
              kind: z.literal("catalog"),
              modelId: nonEmptyString.max(512),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...zcodeOpenCodeAgentRunIdentitySchema.shape,
        operation: z.literal("getRunStatus"),
      })
      .strict(),
    z
      .object({
        ...zcodeOpenCodeAgentRunIdentitySchema.shape,
        operation: z.literal("cancelRun"),
        opencodeSessionId: nonEmptyString.max(256).optional(),
      })
      .strict(),
    z
      .object({
        ...zcodeOpenCodeAgentRunIdentitySchema.shape,
        operation: z.literal("respondToPermission"),
        opencodeSessionId: nonEmptyString.max(256),
        requestId: nonEmptyString.max(256),
        optionId: nonEmptyString.max(256),
      })
      .strict(),
  ])
  .refine((value) => value.runId === value.commandId, {
    message: "runId must equal the admitted commandId",
    path: ["runId"],
  });

export type ZCodeOpenCodeAgentRunRequest = z.infer<typeof zcodeOpenCodeAgentRunRequestSchema>;

export const zcodeOpenCodeAgentRunResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      opencodeSessionId: nonEmptyString.max(256),
    })
    .strict(),
  z
    .object({
      status: z.enum([
        "starting",
        "running",
        "cancelling",
        "completed",
        "cancelled",
        "failed",
        "interrupted",
      ]),
      opencodeSessionId: nonEmptyString.max(256).optional(),
      diagnosticCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
      stopReason: z.string().max(128).optional(),
      finalText: z
        .string()
        .max(16 * 1024)
        .optional(),
    })
    .strict(),
  z.object({ status: z.literal("responded") }).strict(),
]);

export type ZCodeOpenCodeAgentRunResult = z.infer<typeof zcodeOpenCodeAgentRunResultSchema>;

/** Host -> CLI normalized event envelope; connection generation is derived by the receiver. */
export const zcodeOpenCodeAgentRunEventSchema = z
  .object({
    protocolVersion: z.literal(1),
    zcodeSessionId: nonEmptyString.max(256),
    commandId: nonEmptyString.max(256),
    runId: nonEmptyString.max(256),
    opencodeSessionId: nonEmptyString.max(256),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    event: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("started"),
          modelOptionId: z.string().max(256).optional(),
          modelValue: z.string().max(512).optional(),
        })
        .strict(),
      z.object({ type: z.literal("content"), text: z.string().max(16 * 1024) }).strict(),
      z
        .object({
          type: z.literal("tool"),
          toolCallId: nonEmptyString.max(256),
          title: z.string().max(256),
          status: z.string().max(64),
        })
        .strict(),
      z
        .object({
          type: z.literal("permissionRequested"),
          requestId: nonEmptyString.max(256),
          title: z.string().max(256),
          inputSummary: z.string().max(2048).optional(),
          options: z
            .array(
              z
                .object({
                  optionId: nonEmptyString.max(256),
                  name: z.string().max(256),
                  kind: z.string().max(64),
                })
                .strict(),
            )
            .max(32),
        })
        .strict(),
      z
        .object({
          type: z.literal("permissionResolved"),
          requestId: nonEmptyString.max(256),
          optionId: nonEmptyString.max(256).optional(),
          cancelled: z.boolean(),
        })
        .strict(),
      z
        .object({
          type: z.literal("completed"),
          stopReason: z.string().max(128),
          finalText: z
            .string()
            .max(16 * 1024)
            .optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("cancelled"),
          diagnosticCode: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,63}$/)
            .optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("failed"),
          diagnosticCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        })
        .strict(),
      z
        .object({
          type: z.literal("interrupted"),
          diagnosticCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((value) => value.runId === value.commandId, {
    message: "runId must equal the admitted commandId",
    path: ["runId"],
  });

export type ZCodeOpenCodeAgentRunEvent = z.infer<typeof zcodeOpenCodeAgentRunEventSchema>;
