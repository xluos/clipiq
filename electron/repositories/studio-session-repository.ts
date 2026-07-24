import type { DatabaseSync } from "node:sqlite";
import type { StudioSession } from "../../src/types";

type StudioSessionRow = Record<string, any>;

function parseJson<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function mergeDefined<T extends object>(base: T | undefined, patch: Partial<T>): T {
  const merged = { ...(base || {}) } as T;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function toIso(value: unknown): string {
  return new Date(Number(value) || Date.now()).toISOString();
}

export function migrateStudioSessionSchema(db: DatabaseSync): void {
  for (const column of [
    "main_shot_ratio REAL",
    "applied_methodologies TEXT",
    "used_asset_ids TEXT",
    "missing_shots TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE studio_sessions ADD COLUMN ${column}`);
    } catch {
      // 已迁移。
    }
  }
}

export function rowToStudioSession(row: StudioSessionRow): StudioSession {
  return {
    id: row.id,
    goal: row.goal || "",
    targetPlatform: row.target_platform || undefined,
    targetDurationSec: row.target_duration ?? undefined,
    mainShotRatio: row.main_shot_ratio ?? undefined,
    appliedMethodologies: parseJson<string[]>(row.applied_methodologies),
    usedAssetIds: parseJson<string[]>(row.used_asset_ids),
    steps: parseJson<StudioSession["steps"]>(row.steps),
    scriptDraft: row.script_draft || undefined,
    missingShots: parseJson<string[]>(row.missing_shots),
    output: parseJson<StudioSession["output"]>(row.output),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function createStudioSessionRepository(db: DatabaseSync) {
  migrateStudioSessionSchema(db);

  const getRow = db.prepare("SELECT * FROM studio_sessions WHERE id = ?");
  const listRows = db.prepare("SELECT * FROM studio_sessions ORDER BY updated_at DESC");
  const upsertStatement = db.prepare(`
    INSERT INTO studio_sessions (
      id, goal, target_platform, target_duration, main_shot_ratio,
      applied_methodologies, used_asset_ids, steps, script_draft, missing_shots,
      output, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      goal=excluded.goal,
      target_platform=excluded.target_platform,
      target_duration=excluded.target_duration,
      main_shot_ratio=excluded.main_shot_ratio,
      applied_methodologies=excluded.applied_methodologies,
      used_asset_ids=excluded.used_asset_ids,
      steps=excluded.steps,
      script_draft=excluded.script_draft,
      missing_shots=excluded.missing_shots,
      output=excluded.output,
      updated_at=excluded.updated_at
  `);

  return {
    list(): StudioSession[] {
      return listRows.all().map((row) => rowToStudioSession(row as StudioSessionRow));
    },

    get(sessionId: string): StudioSession | null {
      const row = getRow.get(sessionId) as StudioSessionRow | undefined;
      return row ? rowToStudioSession(row) : null;
    },

    upsert(session: Partial<StudioSession> & Pick<StudioSession, "id">): StudioSession {
      const currentRow = getRow.get(session.id) as StudioSessionRow | undefined;
      const current = currentRow ? rowToStudioSession(currentRow) : undefined;
      const merged = mergeDefined(current, session);
      const now = Date.now();

      upsertStatement.run(
        merged.id,
        merged.goal ?? null,
        merged.targetPlatform ?? null,
        merged.targetDurationSec ?? null,
        merged.mainShotRatio ?? null,
        merged.appliedMethodologies ? JSON.stringify(merged.appliedMethodologies) : null,
        merged.usedAssetIds ? JSON.stringify(merged.usedAssetIds) : null,
        merged.steps ? JSON.stringify(merged.steps) : null,
        merged.scriptDraft ?? null,
        merged.missingShots ? JSON.stringify(merged.missingShots) : null,
        merged.output ? JSON.stringify(merged.output) : null,
        Date.parse(merged.createdAt || "") || now,
        now,
      );

      return rowToStudioSession(getRow.get(session.id) as StudioSessionRow);
    },

    delete(sessionId: string): void {
      db.prepare("DELETE FROM studio_sessions WHERE id = ?").run(sessionId);
    },
  };
}
