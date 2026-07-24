import type { DatabaseSync } from "node:sqlite";
import type { Video, VideoRole } from "../../src/types";

export type VideoFilter = {
  accountId?: string;
  collectionId?: string;
  platform?: string;
  status?: string;
  videoRole?: VideoRole;
  unassigned?: boolean;
};

type VideoRow = Record<string, any>;

function parseJsonArray(value: unknown): string[] | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

function toIso(value: unknown): string {
  return new Date(Number(value) || Date.now()).toISOString();
}

function normalizeVideoRole(value: unknown): VideoRole | undefined {
  return value === "analysis" || value === "asset" || value === "account_video"
    ? value
    : undefined;
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

export function migrateVideoRole(db: DatabaseSync): void {
  try {
    db.exec("ALTER TABLE videos ADD COLUMN video_role TEXT NOT NULL DEFAULT 'analysis'");
  } catch {
    // 已迁移。
  }

  // 历史素材入口一直生成 asset-*，账号抓取入口一直生成 av-*。
  // 这里只做一次旧数据回填；运行时归属全部读取 video_role，不再由 account_id 推导。
  db.exec(`
    UPDATE videos
    SET video_role = 'asset'
    WHERE id LIKE 'asset-%' AND video_role = 'analysis';

    UPDATE videos
    SET video_role = 'account_video'
    WHERE id LIKE 'av-%' AND video_role = 'analysis';

    UPDATE videos
    SET video_role = 'analysis'
    WHERE video_role NOT IN ('analysis', 'asset', 'account_video');
  `);
}

export function rowToVideo(row: VideoRow): Video {
  const tags = parseJsonArray(row.tags);
  const videoRole = normalizeVideoRole(row.video_role) || "analysis";
  return {
    id: row.id,
    title: row.title || "",
    sourceType: row.source_type || "local",
    sourceUrl: row.source_url || undefined,
    playUrl: row.play_url || undefined,
    platform: row.platform || undefined,
    externalId: row.external_id || undefined,
    localPath: row.local_path || undefined,
    durationSec: row.duration_sec || 0,
    width: row.width || 0,
    height: row.height || 0,
    orientation: row.orientation || "landscape",
    thumbnailUrl: row.thumbnail_url || undefined,
    accountId: row.account_id || undefined,
    videoRole,
    status: row.status || "ready",
    uploadDate: row.upload_date || undefined,
    viewCount: row.view_count ?? undefined,
    likeCount: row.like_count ?? undefined,
    commentCount: row.comment_count ?? undefined,
    shareCount: row.share_count ?? undefined,
    collectCount: row.collect_count ?? undefined,
    tags,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    // v2 兼容字段只从显式角色派生，不能再用 account_id 判断。
    videoName: row.title || "",
    localVideoPath: row.local_path ? `media://local/${encodeURIComponent(row.local_path)}` : undefined,
    localFilePath: row.local_path || undefined,
    source: row.source_type === "url"
      ? { type: "url", url: row.source_url || "", platform: row.platform || "unknown" }
      : { type: "local_file", originalPath: row.local_path || "" },
    kind: videoRole,
    assetTags: tags || [],
  };
}

export function createVideoRepository(db: DatabaseSync) {
  migrateVideoRole(db);

  const getRow = db.prepare("SELECT * FROM videos WHERE id = ?");
  const upsertStatement = db.prepare(`
    INSERT INTO videos (id, title, source_type, source_url, play_url, platform, external_id, local_path,
      duration_sec, width, height, orientation, thumbnail_url, account_id, video_role, status,
      upload_date, view_count, like_count, comment_count, share_count, collect_count,
      tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, source_type=excluded.source_type, source_url=excluded.source_url,
      play_url=excluded.play_url, platform=excluded.platform, external_id=excluded.external_id,
      local_path=excluded.local_path, duration_sec=excluded.duration_sec, width=excluded.width,
      height=excluded.height, orientation=excluded.orientation, thumbnail_url=excluded.thumbnail_url,
      account_id=excluded.account_id, video_role=excluded.video_role, status=excluded.status,
      upload_date=excluded.upload_date, view_count=excluded.view_count, like_count=excluded.like_count,
      comment_count=excluded.comment_count, share_count=excluded.share_count,
      collect_count=excluded.collect_count, tags=excluded.tags, updated_at=excluded.updated_at
  `);

  return {
    list(filter: VideoFilter = {}): Video[] {
      const conditions: string[] = [];
      const params: Array<string> = [];
      if (filter.accountId) {
        conditions.push("account_id = ?");
        params.push(filter.accountId);
      }
      if (filter.platform) {
        conditions.push("platform = ?");
        params.push(filter.platform);
      }
      if (filter.status) {
        conditions.push("status = ?");
        params.push(filter.status);
      }
      if (filter.videoRole) {
        conditions.push("video_role = ?");
        params.push(filter.videoRole);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

      if (filter.collectionId) {
        const extra = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
        return db.prepare(`
          SELECT v.*
          FROM videos v
          JOIN collection_videos cv ON cv.video_id = v.id
          WHERE cv.collection_id = ?${extra}
          ORDER BY cv.position, v.updated_at DESC
        `).all(filter.collectionId, ...params).map((row) => rowToVideo(row as VideoRow));
      }

      if (filter.unassigned) {
        const extra = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
        return db.prepare(`
          SELECT *
          FROM videos
          WHERE account_id IS NULL
            AND id NOT IN (SELECT video_id FROM collection_videos)${extra}
          ORDER BY updated_at DESC
        `).all(...params).map((row) => rowToVideo(row as VideoRow));
      }

      return db.prepare(`SELECT * FROM videos${where} ORDER BY updated_at DESC`)
        .all(...params)
        .map((row) => rowToVideo(row as VideoRow));
    },

    get(videoId: string): Video | null {
      const row = getRow.get(videoId) as VideoRow | undefined;
      return row ? rowToVideo(row) : null;
    },

    upsert(video: Partial<Video> & Pick<Video, "id">): Video {
      const currentRow = getRow.get(video.id) as VideoRow | undefined;
      const current = currentRow ? rowToVideo(currentRow) : undefined;
      const merged = mergeDefined(current, video);
      const now = Date.now();
      const role = normalizeVideoRole(video.videoRole)
        || normalizeVideoRole(video.kind)
        || current?.videoRole
        || "analysis";

      upsertStatement.run(
        merged.id,
        merged.title || "",
        merged.sourceType || "local",
        merged.sourceUrl || null,
        merged.playUrl || null,
        merged.platform || null,
        merged.externalId || null,
        merged.localPath || null,
        merged.durationSec || 0,
        merged.width || 0,
        merged.height || 0,
        merged.orientation || "landscape",
        merged.thumbnailUrl || null,
        merged.accountId || null,
        role,
        merged.status || "ready",
        merged.uploadDate || null,
        merged.viewCount ?? null,
        merged.likeCount ?? null,
        merged.commentCount ?? null,
        merged.shareCount ?? null,
        merged.collectCount ?? null,
        merged.tags ? JSON.stringify(merged.tags) : null,
        Date.parse(merged.createdAt || "") || now,
        now,
      );

      return rowToVideo(getRow.get(video.id) as VideoRow);
    },
  };
}
