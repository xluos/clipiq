import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { AnalysisNode, ShotContext } from "../src/types";
import { buildShotsFromAnalysis } from "../electron/editing/analysis-shot-sync";
import {
  createShotRepository,
  migrateShotSchema,
} from "../electron/repositories/shot-repository";

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];

function createDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE shots (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      shot_index INTEGER NOT NULL,
      start_sec REAL DEFAULT 0,
      end_sec REAL DEFAULT 0,
      thumbnail_url TEXT,
      description TEXT,
      shot_type TEXT,
      camera_movement TEXT,
      usage_tags TEXT,
      is_favorite INTEGER DEFAULT 0,
      subtitle_text TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function analysisNode(patch: Partial<AnalysisNode>): AnalysisNode {
  return {
    id: "node",
    startSec: 0,
    endSec: 1,
    title: "节点",
    nodeTypes: ["shot_change"],
    shotDescription: "",
    visualElements: [],
    audioElements: [],
    editIntent: "",
    emotionLabel: "",
    emotionIntensity: 0,
    narrativeFunction: "",
    confidence: 1,
    isHighlight: false,
    ...patch,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("完整分析结果 → Shot", () => {
  it("按真实时间重叠合并 ShotContext 和节点语义，并保留字幕分段", () => {
    const contexts: ShotContext[] = [
      {
        shotIndex: 0,
        startSec: 0,
        endSec: 3,
        shotDescription: "小林在营地展开帐篷并说明搭建顺序。",
        representativeFrames: [{
          thumbnailUrl: "media://shot-1.jpg",
          framePath: "/tmp/shot-1.jpg",
          midSec: 1.5,
        }],
        subtitleSegments: [{
          start: 0.25,
          end: 2.2,
          text: "我们先把帐篷铺开",
          speakerId: "speaker-1",
          words: [
            { text: "我们先", start: 0.25, end: 0.9 },
            { text: "把帐篷铺开", start: 0.9, end: 2.2 },
          ],
        }],
        subtitleText: "我们先把帐篷铺开",
      },
      {
        shotIndex: 1,
        startSec: 3,
        endSec: 6,
        shotDescription: "帐篷搭好后，小林面向镜头收尾。",
        frames: [{
          thumbnailUrl: "media://shot-2.jpg",
          framePath: "/tmp/shot-2.jpg",
          midSec: 4.5,
        }],
      },
    ];
    const nodes = [
      analysisNode({
        id: "node-1",
        startSec: 0,
        endSec: 3,
        shotType: "medium",
        cameraMovement: "手持跟拍",
        audioElements: ["人物对白", "帐篷布摩擦声"],
        narrativeFunction: "开场钩子",
        isHighlight: true,
      }),
      analysisNode({
        id: "node-2",
        startSec: 3,
        endSec: 6,
        shotType: "wide",
        cameraMovement: "固定镜头",
        audioElements: ["环境自然声"],
        narrativeFunction: "结尾收束",
      }),
    ];

    const shots = buildShotsFromAnalysis("video-1", {
      nodes,
      report: { shotContexts: contexts },
    });

    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({
      id: "video-1-shot-1",
      videoId: "video-1",
      startSec: 0,
      endSec: 3,
      thumbnailUrl: "media://shot-1.jpg",
      description: "小林在营地展开帐篷并说明搭建顺序。",
      shotType: "medium",
      cameraMovement: "手持跟拍",
      usageTags: ["hook", "highlight"],
      subtitleText: "我们先把帐篷铺开",
      subtitleSegments: [{
        startSec: 0.25,
        endSec: 2.2,
        text: "我们先把帐篷铺开",
        speakerId: "speaker-1",
        words: [
          { text: "我们先", startSec: 0.25, endSec: 0.9 },
          { text: "把帐篷铺开", startSec: 0.9, endSec: 2.2 },
        ],
      }],
      transcriptGranularity: "word",
      audioSummary: "人物对白 / 帐篷布摩擦声",
    });
    expect(shots[1]).toMatchObject({
      id: "video-1-shot-2",
      startSec: 3,
      endSec: 6,
      thumbnailUrl: "media://shot-2.jpg",
      shotType: "wide",
      usageTags: ["ending"],
      audioSummary: "环境自然声",
    });
  });

  it("过滤非法时间范围，并按真实时间生成稳定 ID", () => {
    const shots = buildShotsFromAnalysis("video-2", {
      nodes: [],
      report: {
        shotContexts: [
          { shotIndex: 7, startSec: 8, endSec: 10, shotDescription: "后段" },
          { shotIndex: 3, startSec: 1, endSec: 2, shotDescription: "前段" },
          { shotIndex: 4, startSec: 5, endSec: 4, shotDescription: "非法" },
        ],
      },
    });

    expect(shots.map((shot) => ({
      id: shot.id,
      startSec: shot.startSec,
      usageTags: shot.usageTags,
    }))).toEqual([
      { id: "video-2-shot-1", startSec: 1, usageTags: ["hook"] },
      { id: "video-2-shot-2", startSec: 8, usageTags: ["ending"] },
    ]);
  });
});

describe("Shot repository", () => {
  it("migration 可重复，分析同步可覆盖语义并保留收藏状态", () => {
    const db = createDatabase();
    db.exec(`
      INSERT INTO shots (
        id, video_id, shot_index, start_sec, end_sec, description,
        usage_tags, is_favorite, created_at
      )
      VALUES (
        'video-1-shot-1', 'video-1', 1, 0, 3, '旧描述',
        '["B-roll"]', 1, 1000
      );
    `);

    migrateShotSchema(db);
    migrateShotSchema(db);
    const repository = createShotRepository(db);
    const synced = buildShotsFromAnalysis("video-1", {
      nodes: [analysisNode({
        startSec: 0,
        endSec: 3,
        narrativeFunction: "动作过程",
        audioElements: ["环境声"],
      })],
      report: {
        shotContexts: [{
          shotIndex: 0,
          startSec: 0,
          endSec: 3,
          shotDescription: "新描述",
          subtitleSegments: [{ start: 0.4, end: 1.8, text: "开始搭帐篷" }],
        }],
      },
    });

    repository.replaceForVideo("video-1", synced, { preserveFavorites: true });
    repository.replaceForVideo("video-1", synced, { preserveFavorites: true });

    expect(repository.list("video-1")).toEqual([
      expect.objectContaining({
        id: "video-1-shot-1",
        description: "新描述",
        usageTags: ["action"],
        isFavorite: true,
        subtitleSegments: [{
          startSec: 0.4,
          endSec: 1.8,
          text: "开始搭帐篷",
        }],
        transcriptGranularity: "segment",
        audioSummary: "环境声",
      }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM shots").get())
      .toEqual({ count: 1 });
  });
});
