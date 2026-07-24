import type { DatabaseSync } from "node:sqlite";
import type { EditFeedbackEvent } from "../../src/types";

type Row = Record<string, any>;

export function migrateEditFeedbackSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edit_feedback_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      resulting_plan_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_json TEXT NOT NULL,
      before_revision INTEGER NOT NULL,
      after_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edit_feedback_session_created
      ON edit_feedback_events(session_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_edit_feedback_plan_created
      ON edit_feedback_events(plan_id, created_at ASC);
  `);
}

function rowToEvent(row: Row): EditFeedbackEvent {
  let action: EditFeedbackEvent["action"];
  try {
    action = JSON.parse(row.action_json);
  } catch {
    throw new Error(`粗剪反馈数据损坏: ${row.id}`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    planId: row.plan_id,
    resultingPlanId: row.resulting_plan_id,
    action,
    beforeRevision: row.before_revision,
    afterRevision: row.after_revision,
    createdAt: row.created_at,
  };
}

export function createEditFeedbackRepository(db: DatabaseSync) {
  migrateEditFeedbackSchema(db);
  const insertStatement = db.prepare(`
    INSERT INTO edit_feedback_events (
      id, session_id, plan_id, resulting_plan_id, action_type, action_json,
      before_revision, after_revision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listSessionStatement = db.prepare(`
    SELECT * FROM edit_feedback_events
    WHERE session_id = ?
    ORDER BY created_at ASC, id
  `);
  const listPlanStatement = db.prepare(`
    SELECT * FROM edit_feedback_events
    WHERE plan_id = ? OR resulting_plan_id = ?
    ORDER BY created_at ASC, id
  `);

  return {
    record(event: EditFeedbackEvent): void {
      insertStatement.run(
        event.id,
        event.sessionId,
        event.planId,
        event.resultingPlanId,
        event.action.type,
        JSON.stringify(event.action),
        event.beforeRevision,
        event.afterRevision,
        event.createdAt,
      );
    },

    listForSession(sessionId: string): EditFeedbackEvent[] {
      return listSessionStatement.all(sessionId).map((row) => rowToEvent(row as Row));
    },

    listForPlan(planId: string): EditFeedbackEvent[] {
      return listPlanStatement.all(planId, planId).map((row) => rowToEvent(row as Row));
    },
  };
}
