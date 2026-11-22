// ============================================================
// MultiEdit Tool - Atomic multi-file, multi-block transaction editing
// ============================================================

import { z } from "zod";
import { EditDiffHunkSchema, type DiffHunk } from "./edit.js";
import { toToolJsonSchema } from "./json-schema.js";

export const MULTI_EDIT_TOOL_NAME = "MultiEdit" as const;

const MultiEditBlockSchema = z
  .object({
    old_string: z
      .string()
      .describe("Exact text to find and replace inside this file (may span multiple lines)"),
    new_string: z.string().describe("Replacement text for this block"),
  })
  .strict();

export const MultiEditOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("edit"),
      file_path: z.string().min(1).describe("Absolute path (or workspace-relative) to edit"),
      edits: z
        .array(MultiEditBlockSchema)
        .min(1)
        .describe("Ordered list of non-overlapping search/replace blocks inside this file"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      file_path: z.string().min(1),
      content: z.string().describe("Full file content to create"),
      overwrite: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      file_path: z.string().min(1),
    })
    .strict(),
]);

export type MultiEditOperation = z.infer<typeof MultiEditOperationSchema>;

export const MultiEditInputSchema = z
  .object({
    operations: z
      .array(MultiEditOperationSchema)
      .min(1)
      .describe(
        "Atomic transaction: a list of create / edit / delete operations applied to multiple files as one unit (all-or-nothing).",
      ),
    run_in_background: z
      .boolean()
      .optional()
      .default(false)
      .describe("Schedule the transaction asynchronously for very large batches"),
    strict_syntax_validation: z
      .boolean()
      .optional()
      .default(true)
      .describe("Reject the transaction if it introduces syntax errors (default true)"),
    allow_syntax_draft: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force-commit even if a new syntax error is detected (draft mode)"),
  })
  .strict();

export type MultiEditInput = z.infer<typeof MultiEditInputSchema>;

export const MultiEditInputJsonSchema = toToolJsonSchema(MultiEditInputSchema);

export const MultiEditFileResultSchema = z
  .object({
    filePath: z.string(),
    operation: z.enum(["create", "update", "delete", "move", "noop"]),
    appliedTier: z.string().optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(EditDiffHunkSchema),
    syntaxValid: z.boolean().optional(),
  })
  .strict();

export const MultiEditOutputSchema = z
  .object({
    transactionId: z.string(),
    status: z.enum([
      "committed",
      "rejected_conflict",
      "rejected_stale",
      "rejected_syntax",
      "rolled_back_on_error",
      "cancelled",
      "background_started",
    ]),
    files: z.array(MultiEditFileResultSchema),
    summary: z.string(),
    structuredPatch: z.array(EditDiffHunkSchema),
    errorCode: z.string().optional(),
    syntaxDiagnostics: z
      .array(
        z
          .object({
            filePath: z.string(),
            language: z.string(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            message: z.string().optional(),
            snippet: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    backgroundTaskId: z.string().optional(),
  })
  .strict();

export type MultiEditOutput = z.infer<typeof MultiEditOutputSchema>;
export type MultiEditFileResult = z.infer<typeof MultiEditFileResultSchema>;

export const MultiEditOutputJsonSchema = toToolJsonSchema(MultiEditOutputSchema);

export const MultiEditErrorCode = {
  EMPTY_OPERATIONS: "multi_edit_empty_operations",
  EMPTY_EDITS: "multi_edit_empty_edits",
  SYNTAX_VALIDATION_FAILED: "multi_edit_syntax_validation_failed",
  STALE_FILE: "multi_edit_stale_file",
  CONFLICT: "multi_edit_conflict",
  COMMIT_FAILED: "multi_edit_commit_failed",
  CANCELLED: "multi_edit_cancelled",
} as const;

export type MultiEditErrorCode = (typeof MultiEditErrorCode)[keyof typeof MultiEditErrorCode];

export interface MultiEditToolOutputFile {
  filePath: string;
  operation: "create" | "update" | "delete" | "move" | "noop";
  appliedTier?: string;
  additions: number;
  deletions: number;
  structuredPatch: DiffHunk[];
  syntaxValid?: boolean;
}
