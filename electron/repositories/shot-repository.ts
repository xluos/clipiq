import type { DatabaseSync } from "node:sqlite";
import type { Shot } from "../../src/types";

type ShotRow = Record<string, any>;

function parseJson<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function toIso(value: unknown): string {
  return new Date(Number(value) || Date.now()).toISOString();
}

function temporalOverlapRatio(a: Shot, b: Shot): number {
  const overlap = Math.max(
    0,
    Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec),
  );
  const shorterDuration = Math.min(
    Math.max(0, a.endSec - a.startSec),
    Math.max(0, b.endSec - b.startSec),
  );
  return shorterDuration > 0 ? overlap / shorterDuration : 0;
}

export function migrateShotSchema(db: DatabaseSync): void {
  for (const column of [
    "subtitle_segments TEXT",
    "transcript_granularity TEXT",
    "audio_summary TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE shots ADD COLUMN ${column}`);
    } catch {
      // 已迁移。
    }
  }
}

export function rowToShot(row: ShotRow): Shot {
  return {
    id: row.id,
    assetProjectId: row.video_id,
    videoId: row.video_id,
    shotIndex: row.shot_index || 0,
    startSec: row.start_sec || 0,
    endSec: row.end_sec || 0,
    thumbnailUrl: row.thumbnail_url || undefined,
    description: row.description || "",
    shotType: row.shot_type || undefined,
    cameraMovement: row.camera_movement || undefined,
    usageTags: parseStringArray(row.usage_tags),
    isFavorite: Boolean(row.is_favorite),
    subtitleText: row.subtitle_text || undefined,
    subtitleSegments: parseJson<Shot["subtitleSegments"]>(row.subtitle_segments),
    transcriptGranularity: row.transcript_granularity || undefined,
    audioSummary: row.audio_summary || undefined,
    createdAt: row.created_at ? toIso(row.created_at) : undefined,
  };
}

export function createShotRepository(db: DatabaseSync) {
  migrateShotSchema(db);

  const listForVideoStatement = db.prepare(
    "SELECT * FROM shots WHERE video_id = ? ORDER BY shot_index",
  );
  const listAllStatement = db.prepare("SELECT * FROM shots ORDER BY video_id, shot_index");
  const insertStatement = db.prepare(`
    INSERT INTO shots (
      id, video_id, shot_index, start_sec, end_sec, thumbnail_url, description,
      shot_type, camera_movement, usage_tags, is_favorite, subtitle_text,
      subtitle_segments, transcript_granularity, audio_summary, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const list = (videoId?: string): Shot[] => {
    const rows = videoId
      ? listForVideoStatement.all(videoId)
      : listAllStatement.all();
    return rows.map((row) => rowToShot(row as ShotRow));
  };

  return {
    list,

    replaceForVideo(
      videoId: string,
      shots: Shot[],
      options: { preserveFavorites?: boolean } = {},
    ): Shot[] {
      if (!videoId) throw new Error("replaceForVideo 需要 videoId");
      const existingById = new Map(
        list(videoId).map((shot) => [shot.id, shot]),
      );
      const favoriteShots = [...existingById.values()].filter((shot) => shot.isFavorite);
      const now = Date.now();

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM shots WHERE video_id = ?").run(videoId);
        for (const [index, shot] of (shots || []).entries()) {
          const id = shot.id || `${videoId}-shot-${index + 1}`;
          const existing = existingById.get(id);
          const isFavorite = options.preserveFavorites
            ? Boolean(
                shot.isFavorite
                || favoriteShots.some((favorite) => temporalOverlapRatio(favorite, shot) >= 0.6),
              )
            : Boolean(shot.isFavorite);
          insertStatement.run(
            id,
            videoId,
            shot.shotIndex ?? index + 1,
            shot.startSec ?? 0,
            shot.endSec ?? 0,
            shot.thumbnailUrl || null,
            shot.description || null,
            shot.shotType || null,
            shot.cameraMovement || null,
            JSON.stringify(shot.usageTags || []),
            isFavorite ? 1 : 0,
            shot.subtitleText || null,
            shot.subtitleSegments ? JSON.stringify(shot.subtitleSegments) : null,
            shot.transcriptGranularity || null,
            shot.audioSummary || null,
            Date.parse(existing?.createdAt || shot.createdAt || "") || now,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 保留原始错误。
        }
        throw error;
      }

      return list(videoId);
    },
  };
}
