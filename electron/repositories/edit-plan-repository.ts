import type { DatabaseSync } from "node:sqlite";
import type { EditPlan } from "../../src/types";

type Row = Record<string, any>;

export function migrateEditPlanSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edit_plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edit_plans_session_updated
      ON edit_plans(session_id, updated_at DESC);
  `);
}

function rowToEditPlan(row: Row): EditPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.plan_json);
  } catch {
    throw new Error(`EditPlan 数据损坏: ${row.id}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`EditPlan 数据无效: ${row.id}`);
  }
  return parsed as EditPlan;
}

export function createEditPlanRepository(db: DatabaseSync) {
  migrateEditPlanSchema(db);
  const listForSessionStatement = db.prepare(`
    SELECT * FROM edit_plans WHERE session_id = ? ORDER BY updated_at DESC, id
  `);
  const listAllStatement = db.prepare(`
    SELECT * FROM edit_plans ORDER BY updated_at DESC, id
  `);
  const getStatement = db.prepare("SELECT * FROM edit_plans WHERE id = ?");

  return {
    list(sessionId?: string): EditPlan[] {
      const rows = sessionId
        ? listForSessionStatement.all(sessionId)
        : listAllStatement.all();
      return rows.map((row) => rowToEditPlan(row as Row));
    },

    get(id: string): EditPlan | null {
      const row = getStatement.get(id) as Row | undefined;
      return row ? rowToEditPlan(row) : null;
    },

    save(plan: EditPlan): void {
      if (!plan?.id) throw new Error("保存 EditPlan 需要 id");
      if (!plan.sessionId) throw new Error("保存 EditPlan 需要 sessionId");
      if (plan.version !== 1) throw new Error(`不支持的 EditPlan 版本: ${plan.version}`);
      const existing = getStatement.get(plan.id) as Row | undefined;
      const now = Date.now();
      db.prepare(`
        INSERT INTO edit_plans (
          id, session_id, schema_version, status, plan_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          schema_version = excluded.schema_version,
          status = excluded.status,
          plan_json = excluded.plan_json,
          updated_at = excluded.updated_at
      `).run(
        plan.id,
        plan.sessionId,
        plan.version,
        plan.status,
        JSON.stringify(plan),
        existing?.created_at || now,
        now,
      );
    },

    delete(id: string): boolean {
      return Number(db.prepare("DELETE FROM edit_plans WHERE id = ?").run(id).changes) > 0;
    },
  };
}
