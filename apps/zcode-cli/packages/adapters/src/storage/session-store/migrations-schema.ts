import type { DatabaseSync } from "node:sqlite";

// SQL и helpers идемпотентных миграций session-store. Вынесено из migrations.ts,
// чтобы список миграций не превышал лимит строк.
// 恢复备份只保留加法 schema、删除对应 ledger 记录，随后的启动会复跑这些迁移。
// 因此建表迁移必须可重入：sql 是冻结的 checksum 原文，apply 在整套对象已存在时跳过。
// 只有部分对象存在属于非 restore 产生的损坏状态，此时仍执行冻结 SQL 并显式失败，
// 而不是静默接受半套 schema。
export const OPENCODE_AGENT_RUN_OUTBOX_SQL = `
      create table opencode_agent_run (
        schema_version integer not null check(schema_version = 1),
        session_id text not null references session(id) on delete cascade,
        run_id text not null,
        command_id text not null,
        input_id text not null unique references session_input(id) on delete cascade,
        route_kind text not null check(route_kind = 'opencode-cli'),
        requested_model_id text,
        status text not null check(status in (
          'pending', 'dispatching', 'running', 'completed', 'cancelled', 'failed', 'interrupted'
        )),
        event_sequence integer not null check(event_sequence >= 0),
        time_created integer not null,
        time_updated integer not null,
        time_terminal integer,
        opencode_session_id text,
        result_text text check(result_text is null or length(cast(result_text as blob)) <= 32768),
        stop_reason text,
        diagnostic_code text,
        primary key(session_id, run_id),
        unique(command_id),
        check(run_id = command_id),
        check(
          (status in ('completed', 'cancelled', 'failed', 'interrupted') and time_terminal is not null and opencode_session_id is null)
          or (status = 'running' and time_terminal is null and opencode_session_id is not null)
          or (status in ('pending', 'dispatching') and time_terminal is null and opencode_session_id is null)
        )
      );

      create index opencode_agent_run_session_created_idx
        on opencode_agent_run(session_id, time_created, run_id);
      create index opencode_agent_run_outbox_idx
        on opencode_agent_run(status, time_created, run_id)
        where status = 'pending';
    `;

export const SWARM_RUN_JOURNAL_SQL = `
      create table swarm_run (
        schema_version integer not null check(schema_version = 1),
        root_session_id text not null references session(id) on delete cascade,
        source_command_id text not null,
        run_id text not null primary key,
        root_turn_id text not null,
        graph_json text check(graph_json is null or length(cast(graph_json as blob)) <= 120000),
        status text not null check(status in (
          'planning', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
        )),
        owner_epoch integer not null check(owner_epoch >= 0),
        revision integer not null check(revision >= 0),
        time_created integer not null,
        time_updated integer not null,
        time_terminal integer,
        diagnostic_code text,
        unique(root_session_id, source_command_id),
        check(
          (status in ('completed', 'failed', 'cancelled', 'interrupted') and time_terminal is not null)
          or (status in ('planning', 'running') and time_terminal is null)
        ),
        check(status != 'running' or graph_json is not null)
      );
      create index swarm_run_session_created_idx
        on swarm_run(root_session_id, time_created, run_id);
      create index swarm_run_recovery_idx
        on swarm_run(status, time_updated, run_id)
        where status in ('planning', 'running');

      create table swarm_node_attempt (
        schema_version integer not null check(schema_version = 1),
        run_id text not null references swarm_run(run_id) on delete cascade,
        node_id text not null,
        attempt_id text not null,
        attempt_no integer not null check(attempt_no >= 1),
        status text not null check(status in (
          'pending', 'dispatching', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked'
        )),
        child_session_id text not null unique,
        owner_epoch integer not null check(owner_epoch >= 0),
        revision integer not null check(revision >= 0),
        time_created integer not null,
        time_updated integer not null,
        time_terminal integer,
        result_text text check(result_text is null or length(cast(result_text as blob)) <= 32768),
        diagnostic_code text,
        primary key(run_id, node_id, attempt_id),
        unique(run_id, node_id, attempt_no),
        check(
          (status in ('completed', 'failed', 'cancelled', 'interrupted', 'blocked') and time_terminal is not null)
          or (status in ('pending', 'dispatching', 'running') and time_terminal is null)
        )
      );
      create index swarm_node_attempt_run_idx
        on swarm_node_attempt(run_id, node_id, attempt_no);
      create index swarm_node_attempt_recovery_idx
        on swarm_node_attempt(status, time_updated, run_id)
        where status in ('pending', 'dispatching', 'running');
    `;

export function hasSchemaObject(db: DatabaseSync, type: "table" | "index", name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get(type, name));
}

export function hasAllSchemaObjects(
  db: DatabaseSync,
  objects: readonly (readonly [type: "table" | "index", name: string])[],
): boolean {
  return objects.every(([type, name]) => hasSchemaObject(db, type, name));
}
