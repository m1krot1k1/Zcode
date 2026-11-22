import { z } from "zod";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import { nonEmptyString } from "./schema-core.js";

// ── 已保存工作流的 GUI 中枢──
// workspace 级、无会话的五个方法，照 skills/referenceCatalog 的先例：每次调用现扫
// `<cwd>/.zcode/workflows/`（挂载时快照会漏掉手改的文件）。形状与 @zcode/contracts 的
// saved-workflow.ts 逐字对齐——依赖方向是 contracts → shared，所以这里结构化地再声明一遍，
// 而不是 import；两边的 strict 形状由 bootstrap 侧的协议测试互相钉住。
export const zcodeSavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);

export type ZCodeSavedWorkflowArgType = z.infer<typeof zcodeSavedWorkflowArgTypeSchema>;

export const zcodeSavedWorkflowArgDeclarationSchema = z
  .object({
    type: zcodeSavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();

export type ZCodeSavedWorkflowArgDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgDeclarationSchema
>;

export const zcodeSavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  zcodeSavedWorkflowArgDeclarationSchema,
);

export type ZCodeSavedWorkflowArgsDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgsDeclarationSchema
>;

export const zcodeSavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

export type ZCodeSavedWorkflowMeta = z.infer<typeof zcodeSavedWorkflowMetaSchema>;

// 作用域两档：项目档落 `<cwd>/.zcode/workflows/`、全局档落 agent 机器的 `~/.zcode/workflows/`。作用域由文件所在目录推得，frontmatter 不存 scope。
export const zcodeSavedWorkflowScopeSchema = z.enum(["project", "global"]);

export type ZCodeSavedWorkflowScope = z.infer<typeof zcodeSavedWorkflowScopeSchema>;

export const zcodeSavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
    scope: zcodeSavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();

export type ZCodeSavedWorkflowEntry = z.infer<typeof zcodeSavedWorkflowEntrySchema>;

export const zcodeSavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();

export type ZCodeSavedWorkflowInvalidEntry = z.infer<typeof zcodeSavedWorkflowInvalidEntrySchema>;

/** 名字非法 / 未找到 / frontmatter 坏 / 读错——与 core store 的 resolve 失败四态逐字对应。 */
export const zcodeSavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);

export type ZCodeSavedWorkflowFailureReason = z.infer<typeof zcodeSavedWorkflowFailureReasonSchema>;

const zcodeSavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: zcodeSavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

export const zcodeWorkflowsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // 缺省即 `project`（本项目档）。给 `global` 时改扫本机 `~/.zcode/workflows/`；此时 `workspace`
    // 仍必填，但只是**载体运行时**——协议处理器对全局档不读它的路径。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsListParams = z.infer<typeof zcodeWorkflowsListParamsSchema>;

export const zcodeWorkflowsListResultSchema = z
  .object({
    workflows: z.array(zcodeSavedWorkflowEntrySchema),
    invalid: z.array(zcodeSavedWorkflowInvalidEntrySchema),
    // 扫过的目录（本地绝对路径），即使目录还不存在也回：GUI 的文件监听靠它 watch。
    dir: nonEmptyString,
  })
  .strict();

export type ZCodeWorkflowsListResult = z.infer<typeof zcodeWorkflowsListResultSchema>;

export const zcodeWorkflowsGetParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时只查本机全局根。`workspace` 语义同 list（全局档只当载体）。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsGetParams = z.infer<typeof zcodeWorkflowsGetParamsSchema>;

export const zcodeWorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      meta: zcodeSavedWorkflowMetaSchema,
      /** 脚本本体（frontmatter 之后逐字节），即被类型检查与执行的那一份。 */
      script: z.string(),
    })
    .strict(),
  zcodeSavedWorkflowFailureSchema,
]);

export type ZCodeWorkflowsGetResult = z.infer<typeof zcodeWorkflowsGetResultSchema>;

export const zcodeWorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // 缺省 `project`；`global` 时只写本机全局根那一份。`workspace` 语义同 list。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsUpdateMetaParams = z.infer<typeof zcodeWorkflowsUpdateMetaParamsSchema>;

export const zcodeWorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);

export type ZCodeWorkflowsUpdateMetaResult = z.infer<typeof zcodeWorkflowsUpdateMetaResultSchema>;

export const zcodeWorkflowsDeleteParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时按 scope 选根删除（不再写死 roots[0]）。`workspace` 语义同 list。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsDeleteParams = z.infer<typeof zcodeWorkflowsDeleteParamsSchema>;

export const zcodeWorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);

export type ZCodeWorkflowsDeleteResult = z.infer<typeof zcodeWorkflowsDeleteResultSchema>;

export const ZCODE_WORKFLOWS_RUNS_MAX_LIMIT = 50;

export const zcodeWorkflowsRunsParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 只要这个名字的 run（`dwf_run.name` 字面等值）；缺省即本项目全部 run。 */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT),
    // 缺省 `project`：只查 `dwf_run.cwd === workspacePath` 的 run。`global` 时**不**按 cwd 过滤，
    // 跨所有项目取该名字的运行历史（全局工作流在任何项目里跑，历史因此跨 cwd）；结果行带 `cwd`
    // 供 GUI 标项目。`workspace` 语义同 list（全局档只当载体）。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsRunsParams = z.infer<typeof zcodeWorkflowsRunsParamsSchema>;

// 三终态词汇：errored = 脚本之错，stopped = 被停下（可恢复）。
export const zcodeSavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);

export type ZCodeSavedWorkflowRunStatus = z.infer<typeof zcodeSavedWorkflowRunStatusSchema>;

export const zcodeSavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);

export const zcodeSavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: zcodeSavedWorkflowRunStatusSchema,
    // `status === "stopped"` 才在场。
    stopReason: zcodeSavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** 发起它的会话与 CreateWorkflow 工具调用：有这两个才能从中枢打开实例详情。老行可缺。 */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // 实际运行的项目目录（`dwf_run.cwd`）。全局档的 `workflows/runs` 跨 cwd 查询，GUI 用它给
    // 每行标项目；项目档变体里它恒等于 workspacePath，GUI 可忽略。老行可缺。
    cwd: z.string().optional(),
    // 这次运行发布的**用户面产物**：中枢的运行历史行在
    // 状态词之后画一串 kind chips，详情页头部的「最近产物」条取最近一次 completed run 的这一份。
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
    // 只带 chip 画得下的字段（≤ 8 件，取最新版的元数据）；字节与条目经 v4 查询按需读。
    // optional，照上面 `cwd` 的先例：老 CLI 不发，少一个键是退化不是错误。
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export type ZCodeSavedWorkflowRun = z.infer<typeof zcodeSavedWorkflowRunSchema>;

export const zcodeWorkflowsRunsResultSchema = z
  .object({
    runs: z.array(zcodeSavedWorkflowRunSchema),
    /** 为真时才在场：还有更多 run 没进这一页（多取一条判定，不是 length === limit）。 */
    truncated: z.literal(true).optional(),
  })
  .strict();

export type ZCodeWorkflowsRunsResult = z.infer<typeof zcodeWorkflowsRunsResultSchema>;

// workflows/move：把本机全局根的同名文件搬到 `workspace` 项目根。**只此一向**：项目→全局不是搬文件而是模型的概括（「提升为
// 全局」在该项目开新会话、经 SaveWorkflow 另存），所以没有 `to` 参数。同机同用户，rename 优先、EXDEV
// 回落 copy+unlink；逐字节搬，不改内容（frontmatter 不存 scope）；`move` 不覆盖——目标已存在即拒绝
// （覆盖是 SaveWorkflow 经确认窗才有的动作，不变式 7）。`workspace` 既是载体运行时也是目标项目。
export const zcodeWorkflowsMoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();

export type ZCodeWorkflowsMoveParams = z.infer<typeof zcodeWorkflowsMoveParamsSchema>;

export const zcodeWorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** 源落点路径（全局根，搬走前）。 */
      from: nonEmptyString,
      /** 目标落点路径（项目根，搬到处）。 */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists：目标档已有同名（move 不覆盖）；not_found：源档没有这个名字；
      // read_error / write_error：搬运时的 I/O 失败；invalid_name：名字先验没过。
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);

export type ZCodeWorkflowsMoveResult = z.infer<typeof zcodeWorkflowsMoveResultSchema>;

// ── 从一次 run 保存工作流（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
// run, and running it again」）──
// 完成卡的「直接保存」走这条：**不收脚本，只收 runId**——要写的那份正文是这次 run 实际执行的
// 脚本，agent 从 journal 记录（`scriptText`）里读。脚本不经 GUI 走一圈有两个后果值得写下来：
// 修订过的 run 存下的是**结算它的**那一份，而工具行入参被快照裁成预览的老对话也照样存得出
// 同样的字节。名字合法性、覆盖、遮��与类型检查全部复用 SaveWorkflow 的同一套实现（不变式 3）。
/** 另一档已有同名定义（遮蔽事实）；与 contracts 的 SavedWorkflowShadowing 逐字对齐。 */
export const zcodeSavedWorkflowShadowingSchema = z.enum(["hides_global", "hidden_by_project"]);

export type ZCodeSavedWorkflowShadowing = z.infer<typeof zcodeSavedWorkflowShadowingSchema>;

export const zcodeWorkflowsSaveParamsSchema = z
  .object({
    // 两用：既是载体运行时，也是这次 run 的项目——journal 在它那里，项目根也在它那里。
    // 全局档同样带它（与 list/get 的「全局只当载体」不同）：脚本必须从这个 agent 的 journal 读。
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // 缺省 `project`。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
    // 只有 GUI 已经把覆盖警告摆给用户看过时才为 true；缺省即「目标已存在就拒绝」——
    // 覆盖是用户的决定，不是一次保存的副作用（与 `workflows/move` 不覆盖同一条纪律）。
    overwrite: z.boolean().optional(),
  })
  .strict();

export type ZCodeWorkflowsSaveParams = z.infer<typeof zcodeWorkflowsSaveParamsSchema>;

export const zcodeWorkflowsSaveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      path: nonEmptyString,
      /** 写的那一刻重新判定，不回抄入参里的 `overwrite`（与 SaveWorkflow 的 `overwritten` 同源）。 */
      overwritten: z.boolean(),
      shadowing: zcodeSavedWorkflowShadowingSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // run_not_found：journal 里没有这条 run；script_missing：老记录没存脚本原文；
      // target_exists：目标已存在而调用方没说覆盖；compile_failed：类型检查没过，一个字节都没写。
      reason: z.enum([
        "invalid_name",
        "run_not_found",
        "script_missing",
        "target_exists",
        "compile_failed",
        "write_error",
      ]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);

export type ZCodeWorkflowsSaveResult = z.infer<typeof zcodeWorkflowsSaveResultSchema>;

// ── 一次 run 对应哪个已保存工作流 ──
// 完成卡的「已保存」芯片与「再次运行」都问这一个问题，而答案**推导得来、不记在卡上**：重开
// 会话、换一个窗口保存、在对话里保存，都走同一条判定。判定住在 agent 一侧，因为两份事实
// （run 的 journal 记录与磁盘上的定义）都在那里；返回解析好的 entry，用户后来删掉的那一份
// 因此会自动不再算数。
/** 转写自对话的候选：模型用 `SaveWorkflow` 存过、并在入参里认领了这次 run。 */
export const zcodeWorkflowsForRunCandidateSchema = z
  .object({
    name: nonEmptyString,
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();

export type ZCodeWorkflowsForRunCandidate = z.infer<typeof zcodeWorkflowsForRunCandidateSchema>;

/** 候选上界：一次 run 在一段对话里被存过的次数远小于它。 */
export const ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES = 8;

export const zcodeWorkflowsForRunParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    candidates: z
      .array(zcodeWorkflowsForRunCandidateSchema)
      .max(ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES)
      .optional(),
  })
  .strict();

export type ZCodeWorkflowsForRunParams = z.infer<typeof zcodeWorkflowsForRunParamsSchema>;

export const zcodeWorkflowsForRunResultSchema = z
  .object({
    /** 命中的定义；缺席即这次 run 还没有对应的已保存工作流。 */
    entry: zcodeSavedWorkflowEntrySchema.optional(),
    /** 命中的是哪一条规则（诊断与测试用；UI 只看 entry 在不在）。 */
    match: z.enum(["candidate", "script", "name"]).optional(),
    /** 这次 run 跑时用的实参（journal 原样），供「再次运行」预填实参窗。 */
    runArgs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ZCodeWorkflowsForRunResult = z.infer<typeof zcodeWorkflowsForRunResultSchema>;
