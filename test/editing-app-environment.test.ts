import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectEditingAppEnvironment,
  type EditingAppEnvironmentOptions,
} from "../electron/editing/editing-app-environment";

const tempDirs: string[] = [];

function tempDir(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "clipiq-editing-app-"));
  tempDirs.push(value);
  return value;
}

function fixture(): {
  root: string;
  applications: string;
  appPath: string;
  draftRoot: string;
  options: EditingAppEnvironmentOptions;
} {
  const root = tempDir();
  const applications = path.join(root, "Applications");
  const appPath = path.join(applications, "剪映专业版.app");
  const draftRoot = path.join(
    root,
    "Movies",
    "JianyingPro",
    "User Data",
    "Projects",
    "com.lveditor.draft",
  );
  mkdirSync(appPath, { recursive: true });
  mkdirSync(path.join(draftRoot, "测试草稿 1"), { recursive: true });
  mkdirSync(path.join(draftRoot, "测试草稿 2"), { recursive: true });
  return {
    root,
    applications,
    appPath,
    draftRoot,
    options: {
      platform: "darwin",
      homeDir: root,
      applicationRoots: [applications],
      draftRootCandidates: [{ kind: "jianying", path: draftRoot }],
      readAppMetadata: () => ({
        name: "剪映专业版",
        bundleId: "com.lemon.lv",
        version: "8.1.0",
        build: "810001",
      }),
      detectedAt: 123,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("剪映 / CapCut 环境只读探测", () => {
  it("没有应用时明确不可用，不创建草稿目录", () => {
    const root = tempDir();
    const applications = path.join(root, "Applications");
    mkdirSync(applications);
    const missingDraftRoot = path.join(root, "missing-drafts");

    const report = detectEditingAppEnvironment({
      platform: "darwin",
      homeDir: root,
      applicationRoots: [applications],
      draftRootCandidates: [{ kind: "jianying", path: missingDraftRoot }],
      detectedAt: 1,
    });

    expect(report).toMatchObject({
      readiness: "not_installed",
      exporterReady: false,
      installations: [],
      draftRoots: [{
        kind: "jianying",
        path: missingDraftRoot,
        exists: false,
        projectCount: 0,
      }],
      issues: [{
        code: "EDITING_APP_NOT_FOUND",
        severity: "warning",
      }],
    });
    expect(report.draftRoots[0].exists).toBe(false);
  });

  it("读取应用版本和已有草稿根目录，但未验证版本不能进入正式导出", () => {
    const value = fixture();
    const report = detectEditingAppEnvironment(value.options);

    expect(report).toMatchObject({
      platform: "darwin",
      detectedAt: 123,
      readiness: "ready_for_spike",
      exporterReady: false,
      installations: [{
        kind: "jianying",
        name: "剪映专业版",
        appPath: value.appPath,
        bundleId: "com.lemon.lv",
        version: "8.1.0",
        build: "810001",
        readable: true,
        compatibility: "unverified",
      }],
      draftRoots: [{
        kind: "jianying",
        path: value.draftRoot,
        source: "override",
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        projectCount: 2,
      }],
    });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TARGET_VERSION_UNVERIFIED" }),
    ]));
  });

  it("只有精确进入已验证矩阵的版本才允许正式 exporter", () => {
    const value = fixture();
    const report = detectEditingAppEnvironment({
      ...value.options,
      verifiedTargets: [{ kind: "jianying", version: "8.1.0" }],
    });

    expect(report.readiness).toBe("ready_for_spike");
    expect(report.exporterReady).toBe(true);
    expect(report.installations[0].compatibility).toBe("verified");
    expect(report.issues.some((issue) =>
      issue.code === "TARGET_VERSION_UNVERIFIED")).toBe(false);
  });

  it("可以从用户目录发现非默认命名的剪映草稿根目录", () => {
    const root = tempDir();
    const applications = path.join(root, "Applications");
    const appPath = path.join(applications, "剪映专业版.app");
    const discoveredRoot = path.join(
      root,
      "Movies",
      "剪映测试版",
      "User Data",
      "Projects",
      "com.lveditor.draft",
    );
    mkdirSync(appPath, { recursive: true });
    mkdirSync(discoveredRoot, { recursive: true });

    const report = detectEditingAppEnvironment({
      platform: "darwin",
      homeDir: root,
      applicationRoots: [applications],
      readAppMetadata: () => ({
        name: "剪映专业版",
        bundleId: "com.lemon.lv",
        version: "9.0.0",
      }),
    });

    expect(report.readiness).toBe("ready_for_spike");
    expect(report.draftRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "jianying",
        path: discoveredRoot,
        source: "discovered",
        exists: true,
      }),
    ]));
  });

  it("非 macOS 不猜测兼容路径", () => {
    const report = detectEditingAppEnvironment({
      platform: "linux",
      detectedAt: 2,
    });

    expect(report).toMatchObject({
      readiness: "unsupported_platform",
      exporterReady: false,
      installations: [],
      draftRoots: [],
      issues: [{
        code: "PLATFORM_UNSUPPORTED",
        severity: "error",
      }],
    });
  });
});
