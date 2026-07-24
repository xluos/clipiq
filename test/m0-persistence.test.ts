import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import {
  createVideoRepository,
  migrateVideoRole,
} from "../electron/repositories/video-repository";
import {
  createStudioSessionRepository,
  migrateStudioSessionSchema,
} from "../electron/repositories/studio-session-repository";

// Vitest 2 内置的旧 Vite 尚未识别 Node 22 的 node:sqlite，静态扫描会误解析成
// npm 包 sqlite。通过 Node 原生 require 加载，测试仍运行真实的内存 SQLite。
const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];

function createDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function createLegacyVideosTable(db: Database): void {
  db.exec(`
    CREATE TABLE videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'local',
      source_url TEXT,
      play_url TEXT,
      platform TEXT,
      external_id TEXT,
      local_path TEXT,
      duration_sec REAL DEFAULT 0,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      orientation TEXT DEFAULT 'landscape',
      thumbnail_url TEXT,
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      upload_date TEXT,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      share_count INTEGER,
      collect_count INTEGER,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE collection_videos (
      collection_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (collection_id, video_id)
    );
  `);
}

function createLegacyStudioSessionsTable(db: Database): void {
  db.exec(`
    CREATE TABLE studio_sessions (
      id TEXT PRIMARY KEY,
      goal TEXT,
      target_platform TEXT,
      target_duration INTEGER,
      steps TEXT,
      script_draft TEXT,
      output TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("M0-1 videos.video_role", () => {
  it("可重复迁移旧库，并按历史 ID 回填显式素材归属", () => {
    const db = createDatabase();
    createLegacyVideosTable(db);
    db.exec(`
      INSERT INTO videos (id, title, created_at, updated_at)
      VALUES
        ('asset-legacy', '旧素材', 1000, 1000),
        ('av-account-1', '账号视频', 1000, 1000),
        ('proj-analysis', '拉片视频', 1000, 1000);
    `);

    migrateVideoRole(db);
    migrateVideoRole(db);

    const rows = db.prepare("SELECT id, video_role FROM videos ORDER BY id").all();
    expect(rows).toEqual([
      { id: "asset-legacy", video_role: "asset" },
      { id: "av-account-1", video_role: "account_video" },
      { id: "proj-analysis", video_role: "analysis" },
    ]);
  });

  it("row mapper 只从 video_role 派生 kind，partial upsert 不清空素材归属和路径", () => {
    const db = createDatabase();
    createLegacyVideosTable(db);
    const repository = createVideoRepository(db);
    const now = new Date(1000).toISOString();

    repository.upsert({
      id: "custom-material",
      title: "露营素材",
      sourceType: "local",
      localPath: "/tmp/camp.mov",
      durationSec: 12,
      width: 1920,
      height: 1080,
      orientation: "landscape",
      videoRole: "asset",
      status: "ready",
      tags: ["露营"],
      createdAt: now,
      updatedAt: now,
    });
    repository.upsert({ id: "custom-material", title: "露营素材 01" });

    const restored = repository.get("custom-material");
    expect(restored).toMatchObject({
      id: "custom-material",
      title: "露营素材 01",
      localPath: "/tmp/camp.mov",
      videoRole: "asset",
      kind: "asset",
      tags: ["露营"],
    });
    expect(repository.list({ videoRole: "asset" }).map((video) => video.id))
      .toEqual(["custom-material"]);
  });
});

describe("M0-1 studio_sessions", () => {
  it("可重复迁移旧表，并完整读回素材、方法论、步骤和缺失镜头", () => {
    const db = createDatabase();
    createLegacyStudioSessionsTable(db);

    migrateStudioSessionSchema(db);
    migrateStudioSessionSchema(db);
    const repository = createStudioSessionRepository(db);
    const now = new Date(1000).toISOString();
    const steps = [{
      index: 1,
      label: "开场",
      body: "搭帐篷",
      shotRefs: [{ assetProjectId: "asset-1", shotId: "shot-1" }],
      missing: "营地远景",
    }];

    repository.upsert({
      id: "session-1",
      goal: "60 秒露营 Vlog",
      targetPlatform: "抖音",
      targetDurationSec: 60,
      mainShotRatio: 0.7,
      appliedMethodologies: ["methodology-1"],
      usedAssetIds: ["asset-1"],
      steps,
      missingShots: ["营地远景"],
      currentEditPlanId: "edit-plan-1",
      output: { kind: "draft" },
      createdAt: now,
      updatedAt: now,
    });

    expect(repository.get("session-1")).toMatchObject({
      goal: "60 秒露营 Vlog",
      targetPlatform: "抖音",
      targetDurationSec: 60,
      mainShotRatio: 0.7,
      appliedMethodologies: ["methodology-1"],
      usedAssetIds: ["asset-1"],
      steps,
      missingShots: ["营地远景"],
      currentEditPlanId: "edit-plan-1",
      output: { kind: "draft" },
    });
  });

  it("partial upsert 保留未提交的完整 Studio 上下文", () => {
    const db = createDatabase();
    createLegacyStudioSessionsTable(db);
    const repository = createStudioSessionRepository(db);
    const now = new Date(1000).toISOString();

    repository.upsert({
      id: "session-2",
      goal: "旧目标",
      mainShotRatio: 0.6,
      appliedMethodologies: ["methodology-1"],
      usedAssetIds: ["asset-1"],
      missingShots: ["补一个结尾"],
      createdAt: now,
      updatedAt: now,
    });
    repository.upsert({ id: "session-2", goal: "新目标" });

    expect(repository.get("session-2")).toMatchObject({
      goal: "新目标",
      mainShotRatio: 0.6,
      appliedMethodologies: ["methodology-1"],
      usedAssetIds: ["asset-1"],
      missingShots: ["补一个结尾"],
    });
  });
});
