import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";

import { SESSION_DATABASE_IDENTITY_MIGRATION } from "@zcode/shared/sqlite-migrations";
import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./migrations/0020-provider-model-selection.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./migrations/0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./migrations/0022-backfilled-session-reasoning.js";

import {
  hasAllSchemaObjects,
  OPENCODE_AGENT_RUN_OUTBOX_SQL,
  SWARM_RUN_JOURNAL_SQL,
} from "./migrations-schema.js";

/**
 * Поздние миграции session-store (0016…0028). Вынесены по лимиту строк;
 * порядок задаётся спредом в SQLITE_MIGRATIONS и не меняется.
 */
export const SQLITE_LATE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    appVersion: "0.15.2",
    id: "0016_session_input_ledger",
    touchedTables: ["session_input"],
    // session_input 账本（16-timeline-authority-plan P3）：输入的 durable 生命周期
    // admitted -> promoted / cancelled / discarded。旧实现里队列/唤醒的存在性只在
    // 进程内存（事件日志也是内存的），崩溃即静默丢；账本让「queue 消失但不进
    // history」不可能静默发生，并为输入类 command 提供 durable 幂等。
    sql: `
      create table if not exists session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index if not exists session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0017_session_input_start_now_delivery",
    touchedTables: ["session_input", "session_input_before_start_now"],
    // 05C：所有 input command 都在执行前落 durable admission，startNow 也需要独立
    // delivery，不能伪装成 queue。SQLite 不能原地修改 CHECK，必须重建表并保全账本。
    sql: `
      alter table session_input rename to session_input_before_start_now;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_start_now;

      drop table session_input_before_start_now;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0018_session_input_failed_status",
    touchedTables: ["session_input", "session_input_before_failed_status"],
    // Bugfix：fork bundle 提交后 child runtime 仍可能同步启动失败。该输入已经被 parent
    // accepted fact 接受，不能伪装成 cancelled/discarded；新增 durable failed 终态，并通过
    // 重建 CHECK 保证旧库升级后也能写入，重启不会再次消费或改写它。
    sql: `
      alter table session_input rename to session_input_before_failed_status;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_failed_status;

      drop table session_input_before_failed_status;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.16.5",
    id: "0019_dwf_journal",
    touchedTables: ["dwf_run", "dwf_actor", "dwf_artifact", "dwf_node", "dwf_event"],
    // dynamic-workflow 执行引擎的 durable journal（docs/execution-engine.md 的 "Journal & storage"）。
    // legacy 的 workflow_* 表只是模板不是家：dwf_* 自成一套，与既有 workflow 机制彼此独立。
    //
    // 本条是 beta 前把开发期 0019–0030 十二条迁移**压成的单一基线**：四张表一次建齐、形状即
    // 0030 之后的终态。中间态（三次为放宽 CHECK 的整表重建、0028 的删列改名）只存在于
    // 内部预览库里，收敛办法是删掉四张 dwf_* 表并清掉 schema_migration 里的 dwf 记账行，
    // 下次启动由本条重建。beta 之后本条
    // 不可再改：runner 按 checksum 记账，历史迁移只能追加。
    //
    // 只为占住 0019 这个槽位，让
    // staging 后续迁移从 0020 起编号，功能分支合回时 ledger 不会撞号。四张表在功能落地前闲置无害。
    //
    // 几条刻意为之的设计：
    // 1) parent_session_id / session_id 是纯 text，不加 FOREIGN KEY——子代理会话跑在内存
    //    event store 上、没有 session 行，而 runner 开着 pragma foreign_keys = on，真加 FK
    //    会把合法的 journal 记录挡在门外。dwf_* 之外的任何表都不被引用，也不引用它们。
    // 2) dwf_run 没有节点上限 / token 预算列：run 级
    //    token 用量只作观察面，即 spent_tokens。
    // 3) dwf_node 的 unique(run_id, actor_id, actor_seq) 不可实现：putNode 是准入→结算→统计
    //    回填的 upsert，actor 坐标分散在三个可空列上；每子代理的 actor_seq 唯一性由引擎守。
    //    report / artifact 行有行无节点：一次写入、status 恒为 completed、actor 三列全空。
    // 4) 可空列一律「NULL 即缺席」：result_json / name / tool_call_id / args_json /
    //    resumed_from / resolved_model / message_boundary / artifact_id / input_json 都解码成
    //    缺席的键（args_json 解成 `{}`），不存哑值。
    // 5) 索引即查询形状（列序反了就只能全表扫）：
    //    - dwf_run_cwd_idx：按 cwd 枚举历史 run，「cwd 等值 + time_updated 倒序 + limit」。
    //    - dwf_node_artifact_idx：本 run 的产物行与按 id 取带标签的 report 行。
    //    - dwf_event_artifact_idx：看板取数按 journal sequence 分页，取数源是 dwf_event 而不是
    //      dwf_node；表达式索引（SQLite ≥ 3.9）让它不必扫整条 journal。第三列 sequence 不是
    //      装饰——没有它规划器宁可走 unique(run_id, sequence) 的自动索引再逐行筛产物。
    sql: `
      create table if not exists dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        args_json text,
        tool_call_id text,
        resumed_from text,
        caps_max_concurrency integer not null,
        spent_tokens integer not null default 0,
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);

      create table if not exists dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_actor_run_idx on dwf_actor(run_id);

      create table if not exists dwf_node (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        input_json text,
        status text not null check(status in ('running', 'completed', 'failed')),
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_node_run_idx on dwf_node(run_id);
      create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

      create table if not exists dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
    `,
  },
  {
    appVersion: "0.16.5",
    id: "0020_provider_model_selection",
    sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL,
    touchedTables: ["message", "part", "session_entry"],
  },
  {
    appVersion: "0.16.5",
    id: "0021_official_glm_selection",
    sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL,
    touchedTables: ["session_entry"],
  },
  {
    appVersion: "0.16.5",
    id: "0022_backfilled_session_reasoning",
    sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL,
    touchedTables: ["session_entry"],
  },
  {
    appVersion: "0.16.9",
    id: "0023_session_soft_delete_outcome",
    previousIds: ["0020_session_soft_delete_outcome"],
    touchedTables: ["session"],
    apply: (db) => {
      const columns = new Set(
        db
          .prepare("pragma table_info(session)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("time_deleted"))
        db.exec("alter table session add column time_deleted integer");
      if (!columns.has("last_outcome")) db.exec("alter table session add column last_outcome text");
    },
    sql: `
      alter table session add column time_deleted integer;
      alter table session add column last_outcome text;
    `,
  },
  { ...SESSION_DATABASE_IDENTITY_MIGRATION, touchedTables: ["zcode_database_identity"] },
  {
    appVersion: "0.16.9",
    id: "0025_opencode_agent_run_outbox",
    touchedTables: ["opencode_agent_run"],
    // 根因：恢复备份会保留加法 schema 但删除对应 ledger 记录（CONTRACT.md），
    // 重启复跑本条时必须可重入；原 SQL 用不带 IF NOT EXISTS 的 DDL，二次执行会
    // 报 "table opencode_agent_run already exists" 并让整个启动迁移失败。
    // sql 保持原文字作为不可变 checksum，apply 只在表缺失时执行同一份 DDL。
    apply: (db) => {
      if (
        hasAllSchemaObjects(db, [
          ["table", "opencode_agent_run"],
          ["index", "opencode_agent_run_session_created_idx"],
          ["index", "opencode_agent_run_outbox_idx"],
        ])
      )
        return;
      db.exec(OPENCODE_AGENT_RUN_OUTBOX_SQL);
    },
    sql: OPENCODE_AGENT_RUN_OUTBOX_SQL,
  },
  {
    appVersion: "0.16.9",
    id: "0026_opencode_host_event_sequence",
    touchedTables: ["opencode_agent_run"],
    apply: (db) => {
      const columns = new Set(
        db
          .prepare("pragma table_info(opencode_agent_run)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("host_event_sequence")) {
        db.exec(
          "alter table opencode_agent_run add column host_event_sequence integer not null default 0",
        );
      }
    },
    sql: `
      alter table opencode_agent_run
        add column host_event_sequence integer not null default 0;
    `,
  },
  {
    appVersion: "0.16.9",
    id: "0027_opencode_run_activity_snapshot",
    touchedTables: ["opencode_agent_run"],
    apply: (db) => {
      const columns = new Set(
        db
          .prepare("pragma table_info(opencode_agent_run)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("prompt_text")) {
        db.exec("alter table opencode_agent_run add column prompt_text text not null default ''");
        db.exec(`
          update opencode_agent_run
          set prompt_text = coalesce((
            select json_extract(session_input.payload, '$.text')
            from session_input where session_input.id = opencode_agent_run.input_id
          ), '')
        `);
      }
      if (!columns.has("activity_json")) {
        db.exec(
          `alter table opencode_agent_run add column activity_json text not null default '{"outputText":"","tools":[]}'`,
        );
      }
    },
    sql: `
      alter table opencode_agent_run add column prompt_text text not null default '';
      alter table opencode_agent_run add column activity_json text not null default '{"outputText":"","tools":[]}';
      update opencode_agent_run
      set prompt_text = coalesce((
        select json_extract(session_input.payload, '$.text')
        from session_input where session_input.id = opencode_agent_run.input_id
      ), '');
    `,
  },
  {
    appVersion: "0.16.9",
    id: "0028_swarm_run_journal",
    touchedTables: ["swarm_run", "swarm_node_attempt"],
    // 同 0025：恢复备份后 ledger 行被删除但表保留，复跑时必须跳过已存在的表。
    apply: (db) => {
      if (
        hasAllSchemaObjects(db, [
          ["table", "swarm_run"],
          ["index", "swarm_run_session_created_idx"],
          ["index", "swarm_run_recovery_idx"],
          ["table", "swarm_node_attempt"],
          ["index", "swarm_node_attempt_run_idx"],
          ["index", "swarm_node_attempt_recovery_idx"],
        ])
      )
        return;
      db.exec(SWARM_RUN_JOURNAL_SQL);
    },
    sql: SWARM_RUN_JOURNAL_SQL,
  },
];
