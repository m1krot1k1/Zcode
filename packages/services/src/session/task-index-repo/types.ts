import type { ZCodeTaskMeta } from "@zcode/shared";

export interface TaskIndexRow {
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: "completed" | "interrupted" | "error" | null;
  cli_deleted?: number | null;
  handoff_pending?: number;

  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

export interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

export interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
}

export interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  unreadAt?: number;
}
