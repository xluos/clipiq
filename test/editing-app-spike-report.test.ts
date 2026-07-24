import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EditingAppEnvironmentReport,
} from "../electron/editing/editing-app-environment";
import {
  REQUIRED_EDITING_APP_SPIKE_CHECKS,
  validateEditingAppSpikeReport,
  type EditingAppSpikeArtifactProbe,
  type EditingAppSpikeReport,
} from "../electron/editing/editing-app-spike-report";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "clipiq-editing-spike-"));
  tempDirs.push(value);
  return value;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function buildFixture() {
  const root = makeTempDir();
  const appPath = path.join(root, "Applications", "剪映专业版.app");
  const draftRoot = path.join(root, "剪映 草稿");
  const isolatedDraftPath = path.join(draftRoot, "ClipIQ Spike 001");
  const reportDir = path.join(root, "report");
  const fixturePath = path.join(reportDir, "fixtures", "manifest.json");
  const evidencePath = path.join(reportDir, "evidence", "result.txt");
  mkdirSync(appPath, { recursive: true });
  mkdirSync(isolatedDraftPath, { recursive: true });
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(fixturePath, '{"id":"fixture-001"}\n');
  writeFileSync(evidencePath, "真机检查证据\n");

  const fixtureRelativePath = "fixtures/manifest.json";
  const evidenceRelativePath = "evidence/result.txt";
  const report: EditingAppSpikeReport = {
    version: 1,
    id: "jianying-8.2.0-macos-arm64-001",
    testedAt: "2026-07-24T10:00:00.000Z",
    app: {
      kind: "jianying",
      name: "剪映专业版",
      bundleId: "com.lemon.lv",
      version: "8.2.0",
      build: "82001",
      appPath,
    },
    draft: {
      rootPath: draftRoot,
      isolatedDraftPath,
    },
    fixture: {
      id: "fixture-001",
      manifestPath: fixtureRelativePath,
      sha256: sha256(fixturePath),
    },
    checks: Object.fromEntries(
      REQUIRED_EDITING_APP_SPIKE_CHECKS.map((key) => [
        key,
        {
          status: "passed",
          evidence: [{
            path: evidenceRelativePath,
            sha256: sha256(evidencePath),
          }],
        },
      ]),
    ),
  };
  const environment: EditingAppEnvironmentReport = {
    platform: "darwin",
    detectedAt: Date.parse("2026-07-24T10:01:00.000Z"),
    readiness: "ready_for_spike",
    exporterReady: false,
    installations: [{
      kind: "jianying",
      name: "剪映专业版",
      appPath,
      bundleId: "com.lemon.lv",
      version: "8.2.0",
      build: "82001",
      readable: true,
      compatibility: "unverified",
    }],
    draftRoots: [{
      kind: "jianying",
      path: draftRoot,
      source: "override",
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      projectCount: 1,
    }],
    issues: [],
  };
  const artifacts: EditingAppSpikeArtifactProbe[] = [
    {
      relativePath: fixtureRelativePath,
      absolutePath: fixturePath,
      exists: true,
      isFile: true,
      sha256: sha256(fixturePath),
    },
    {
      relativePath: evidenceRelativePath,
      absolutePath: evidencePath,
      exists: true,
      isFile: true,
      sha256: sha256(evidencePath),
    },
  ];
  return {
    report,
    environment,
    artifacts,
    isolatedDraftPath,
    draftRoot,
  };
}

afterEach(() => {
  for (const value of tempDirs.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("剪映 / CapCut 真机 Spike 报告门禁", () => {
  it("只在精确环境与九项证据全部匹配时生成已验证目标", () => {
    const value = buildFixture();
    const result = validateEditingAppSpikeReport(
      value.report,
      value.environment,
      value.artifacts,
      {
        path: value.isolatedDraftPath,
        exists: true,
        isDirectory: true,
      },
    );

    expect(result).toEqual({
      valid: true,
      reportId: value.report.id,
      passedCheckCount: REQUIRED_EDITING_APP_SPIKE_CHECKS.length,
      requiredCheckCount: REQUIRED_EDITING_APP_SPIKE_CHECKS.length,
      target: {
        kind: "jianying",
        bundleId: "com.lemon.lv",
        version: "8.2.0",
        build: "82001",
        reportId: value.report.id,
        testedAt: value.report.testedAt,
      },
      issues: [],
    });
  });

  it("缺项、未执行和伪造的证据不能计为通过", () => {
    const value = buildFixture();
    delete value.report.checks.video_timeline;
    value.report.checks.audio_tracks = {
      status: "not_run",
      evidence: [],
    };
    value.report.checks.chinese_subtitles = {
      status: "passed",
      evidence: [{
        path: "evidence/result.txt",
        sha256: "f".repeat(64),
      }],
    };

    const result = validateEditingAppSpikeReport(
      value.report,
      value.environment,
      value.artifacts,
      {
        path: value.isolatedDraftPath,
        exists: true,
        isDirectory: true,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.target).toBeUndefined();
    expect(result.passedCheckCount).toBe(
      REQUIRED_EDITING_APP_SPIKE_CHECKS.length - 3,
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "SPIKE_CHECK_MISSING",
        "SPIKE_CHECK_NOT_RUN",
        "SPIKE_EVIDENCE_ARTIFACT_MISMATCH",
      ]),
    );
  });

  it("当前应用的名称、版本、build 或路径变化后旧报告失效", () => {
    const value = buildFixture();
    value.environment.installations[0].build = "82002";

    const result = validateEditingAppSpikeReport(
      value.report,
      value.environment,
      value.artifacts,
      {
        path: value.isolatedDraftPath,
        exists: true,
        isDirectory: true,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "APP_ENVIRONMENT_MISMATCH",
    }));
  });

  it("隔离草稿越出根目录或已不存在时拒绝报告", () => {
    const value = buildFixture();
    value.report.draft.isolatedDraftPath = path.join(
      path.dirname(value.draftRoot),
      "用户已有草稿",
    );

    const result = validateEditingAppSpikeReport(
      value.report,
      value.environment,
      value.artifacts,
      {
        path: value.report.draft.isolatedDraftPath,
        exists: false,
        isDirectory: false,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "ISOLATED_DRAFT_PATH_INVALID",
        "ISOLATED_DRAFT_NOT_FOUND",
      ]),
    );
  });
});
