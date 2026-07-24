import {
  constants,
  accessSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type EditingAppKind = "jianying" | "capcut";

export type EditingAppMetadata = {
  name?: string;
  bundleId?: string;
  version?: string;
  build?: string;
};

export type EditingAppInstallation = {
  kind: EditingAppKind;
  name: string;
  appPath: string;
  bundleId?: string;
  version?: string;
  build?: string;
  readable: boolean;
  compatibility: "verified" | "unverified";
};

export type EditingDraftRoot = {
  kind: EditingAppKind;
  path: string;
  source: "known_default" | "discovered" | "override";
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  projectCount: number;
};

export type EditingAppEnvironmentIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  kind?: EditingAppKind;
  path?: string;
};

export type EditingAppEnvironmentReport = {
  platform: string;
  detectedAt: number;
  readiness:
    | "unsupported_platform"
    | "not_installed"
    | "app_detected"
    | "ready_for_spike";
  exporterReady: boolean;
  installations: EditingAppInstallation[];
  draftRoots: EditingDraftRoot[];
  issues: EditingAppEnvironmentIssue[];
};

export type VerifiedEditingAppTarget = {
  kind: EditingAppKind;
  bundleId: string;
  version: string;
  build: string;
  reportId: string;
  testedAt: string;
};

export type EditingAppEnvironmentOptions = {
  platform?: string;
  homeDir?: string;
  applicationRoots?: string[];
  draftRootCandidates?: Array<{
    kind: EditingAppKind;
    path: string;
  }>;
  verifiedTargets?: ReadonlyArray<VerifiedEditingAppTarget>;
  readAppMetadata?: (appPath: string) => EditingAppMetadata;
  canAccess?: (targetPath: string, mode: number) => boolean;
  detectedAt?: number;
};

const KNOWN_APP_NAMES = [
  "剪映专业版.app",
  "JianyingPro.app",
  "CapCut.app",
];

// 只有九项真机检查和证据报告全部通过的精确 build 才能加入。
// 当前真机 Spike 尚未执行，保持空数组会让 exporterReady 永远为 false。
export const VERIFIED_EDITING_APP_TARGETS:
  ReadonlyArray<VerifiedEditingAppTarget> = Object.freeze([]);

function canAccessDefault(targetPath: string, mode: number): boolean {
  try {
    accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function readAppMetadataDefault(appPath: string): EditingAppMetadata {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) return {};
  const result = spawnSync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return {};
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      name: String(
        value.CFBundleDisplayName
        || value.CFBundleName
        || "",
      ).trim() || undefined,
      bundleId: String(value.CFBundleIdentifier || "").trim() || undefined,
      version: String(value.CFBundleShortVersionString || "").trim() || undefined,
      build: String(value.CFBundleVersion || "").trim() || undefined,
    };
  } catch {
    return {};
  }
}

function inferKind(value: string): EditingAppKind | undefined {
  const normalized = value.toLocaleLowerCase();
  if (
    normalized.includes("capcut")
    || normalized.includes("lvoverseas")
  ) {
    return "capcut";
  }
  if (
    normalized.includes("剪映")
    || normalized.includes("jianying")
    || normalized.includes("com.lemon.lv")
  ) {
    return "jianying";
  }
  return undefined;
}

function editingAppPathCandidates(applicationRoots: string[]): string[] {
  const values = new Set<string>();
  for (const root of applicationRoots) {
    for (const name of KNOWN_APP_NAMES) {
      values.add(path.join(root, name));
    }
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (
          entry.isDirectory()
          && entry.name.endsWith(".app")
          && inferKind(entry.name)
        ) {
          values.add(path.join(root, entry.name));
        }
      }
    } catch {
      // 应用目录不存在或不可读时继续检查其他候选根目录。
    }
  }
  return [...values].sort();
}

function defaultDraftRootCandidates(
  homeDir: string,
): NonNullable<EditingAppEnvironmentOptions["draftRootCandidates"]> {
  return [
    {
      kind: "jianying",
      path: path.join(
        homeDir,
        "Movies",
        "JianyingPro",
        "User Data",
        "Projects",
        "com.lveditor.draft",
      ),
    },
    {
      kind: "jianying",
      path: path.join(
        homeDir,
        "Library",
        "Application Support",
        "JianyingPro",
        "User Data",
        "Projects",
        "com.lveditor.draft",
      ),
    },
    {
      kind: "capcut",
      path: path.join(
        homeDir,
        "Movies",
        "CapCut",
        "User Data",
        "Projects",
        "com.lveditor.draft",
      ),
    },
    {
      kind: "capcut",
      path: path.join(
        homeDir,
        "Library",
        "Application Support",
        "CapCut",
        "User Data",
        "Projects",
        "com.lveditor.draft",
      ),
    },
  ];
}

function discoveredDraftRootCandidates(
  homeDir: string,
): Array<{
  kind: EditingAppKind;
  path: string;
}> {
  const values: Array<{ kind: EditingAppKind; path: string }> = [];
  for (const base of [
    path.join(homeDir, "Movies"),
    path.join(homeDir, "Library", "Application Support"),
  ]) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const kind = inferKind(entry.name);
        if (!kind) continue;
        values.push({
          kind,
          path: path.join(
            base,
            entry.name,
            "User Data",
            "Projects",
            "com.lveditor.draft",
          ),
        });
      }
    } catch {
      // 用户目录尚未创建时没有可发现项。
    }
  }
  return values;
}

function inspectDraftRoot(
  candidate: {
    kind: EditingAppKind;
    path: string;
  },
  source: EditingDraftRoot["source"],
  canAccess: (targetPath: string, mode: number) => boolean,
): EditingDraftRoot {
  const exists = existsSync(candidate.path);
  let isDirectory = false;
  let projectCount = 0;
  if (exists) {
    try {
      isDirectory = statSync(candidate.path).isDirectory();
      if (isDirectory) {
        projectCount = readdirSync(candidate.path, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .length;
      }
    } catch {
      isDirectory = false;
    }
  }
  return {
    kind: candidate.kind,
    path: candidate.path,
    source,
    exists,
    isDirectory,
    readable: exists && isDirectory
      ? canAccess(candidate.path, constants.R_OK)
      : false,
    writable: exists && isDirectory
      ? canAccess(candidate.path, constants.W_OK)
      : false,
    projectCount,
  };
}

export function detectEditingAppEnvironment(
  options: EditingAppEnvironmentOptions = {},
): EditingAppEnvironmentReport {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const detectedAt = options.detectedAt ?? Date.now();
  const issues: EditingAppEnvironmentIssue[] = [];
  if (platform !== "darwin") {
    return {
      platform,
      detectedAt,
      readiness: "unsupported_platform",
      exporterReady: false,
      installations: [],
      draftRoots: [],
      issues: [{
        code: "PLATFORM_UNSUPPORTED",
        severity: "error",
        message: "当前只实现 macOS 剪映/CapCut 环境探测。",
      }],
    };
  }

  const applicationRoots = options.applicationRoots || [
    "/Applications",
    path.join(homeDir, "Applications"),
  ];
  const readAppMetadata = options.readAppMetadata || readAppMetadataDefault;
  const canAccess = options.canAccess || canAccessDefault;
  const verifiedTargets = options.verifiedTargets || VERIFIED_EDITING_APP_TARGETS;
  const installations: EditingAppInstallation[] = [];

  for (const appPath of editingAppPathCandidates(applicationRoots)) {
    if (!existsSync(appPath)) continue;
    let isDirectory = false;
    try {
      isDirectory = statSync(appPath).isDirectory();
    } catch {
      // 后续按未安装处理。
    }
    if (!isDirectory) continue;
    const metadata = readAppMetadata(appPath);
    const kind = inferKind([
      path.basename(appPath),
      metadata.name,
      metadata.bundleId,
    ].filter(Boolean).join(" "));
    if (!kind) continue;
    const compatibility = metadata.bundleId
      && metadata.version
      && metadata.build
      && verifiedTargets.some((target) =>
        target.kind === kind
        && target.bundleId === metadata.bundleId
        && target.version === metadata.version
        && target.build === metadata.build
        && Boolean(target.reportId)
        && Number.isFinite(Date.parse(target.testedAt)))
      ? "verified"
      : "unverified";
    installations.push({
      kind,
      name: metadata.name || path.basename(appPath, ".app"),
      appPath,
      ...(metadata.bundleId ? { bundleId: metadata.bundleId } : {}),
      ...(metadata.version ? { version: metadata.version } : {}),
      ...(metadata.build ? { build: metadata.build } : {}),
      readable: canAccess(appPath, constants.R_OK),
      compatibility,
    });
  }
  installations.sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.appPath.localeCompare(right.appPath));

  const draftCandidates = options.draftRootCandidates
    ? options.draftRootCandidates.map((candidate) => ({
      ...candidate,
      source: "override" as const,
    }))
    : [
      ...defaultDraftRootCandidates(homeDir).map((candidate) => ({
        ...candidate,
        source: "known_default" as const,
      })),
      ...discoveredDraftRootCandidates(homeDir).map((candidate) => ({
        ...candidate,
        source: "discovered" as const,
      })),
    ];
  const seenDraftRoots = new Set<string>();
  const draftRoots = draftCandidates.flatMap((candidate) => {
    const key = `${candidate.kind}:${path.resolve(candidate.path)}`;
    if (seenDraftRoots.has(key)) return [];
    seenDraftRoots.add(key);
    return [inspectDraftRoot(
      { ...candidate, path: path.resolve(candidate.path) },
      candidate.source,
      canAccess,
    )];
  });

  if (installations.length === 0) {
    issues.push({
      code: "EDITING_APP_NOT_FOUND",
      severity: "warning",
      message: "没有检测到剪映专业版或 CapCut。",
    });
  }
  for (const installation of installations) {
    if (!installation.version) {
      issues.push({
        code: "APP_VERSION_UNKNOWN",
        severity: "warning",
        message: `${installation.name} 已安装，但无法读取版本。`,
        kind: installation.kind,
        path: installation.appPath,
      });
    } else if (installation.compatibility !== "verified") {
      issues.push({
        code: "TARGET_VERSION_UNVERIFIED",
        severity: "info",
        message: `${installation.name} ${installation.version} 尚未通过固定用例真机验证。`,
        kind: installation.kind,
        path: installation.appPath,
      });
    }
    const matchingRoots = draftRoots.filter((root) =>
      root.kind === installation.kind && root.exists);
    if (matchingRoots.length === 0) {
      issues.push({
        code: "DRAFT_ROOT_NOT_FOUND",
        severity: "warning",
        message: `${installation.name} 尚未发现已有草稿根目录；探测器不会自动创建。`,
        kind: installation.kind,
      });
    }
  }
  for (const root of draftRoots.filter((item) => item.exists)) {
    if (!root.isDirectory || !root.readable) {
      issues.push({
        code: "DRAFT_ROOT_UNREADABLE",
        severity: "error",
        message: "草稿根目录存在但不可读。",
        kind: root.kind,
        path: root.path,
      });
    } else if (!root.writable) {
      issues.push({
        code: "DRAFT_ROOT_NOT_WRITABLE",
        severity: "error",
        message: "草稿根目录不可写，不能创建隔离测试草稿。",
        kind: root.kind,
        path: root.path,
      });
    }
  }

  const environmentReady = installations.some((installation) =>
    installation.readable
    && draftRoots.some((root) =>
      root.kind === installation.kind
      && root.exists
      && root.isDirectory
      && root.readable
      && root.writable));
  const exporterReady = installations.some((installation) =>
    installation.compatibility === "verified"
    && installation.readable
    && draftRoots.some((root) =>
      root.kind === installation.kind
      && root.exists
      && root.isDirectory
      && root.readable
      && root.writable));
  return {
    platform,
    detectedAt,
    readiness: installations.length === 0
      ? "not_installed"
      : environmentReady
        ? "ready_for_spike"
        : "app_detected",
    exporterReady,
    installations,
    draftRoots,
    issues,
  };
}
