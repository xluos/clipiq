import path from "node:path";
import type {
  EditingAppEnvironmentReport,
  EditingAppKind,
  VerifiedEditingAppTarget,
} from "./editing-app-environment";

export const REQUIRED_EDITING_APP_SPIKE_CHECKS = [
  "video_timeline",
  "audio_tracks",
  "chinese_subtitles",
  "transition_overlay",
  "restart_reopen_save",
  "manual_export",
  "chinese_space_paths",
  "source_missing_diagnostic",
  "existing_drafts_preserved",
] as const;

export type EditingAppSpikeCheckKey =
  typeof REQUIRED_EDITING_APP_SPIKE_CHECKS[number];

export type EditingAppSpikeEvidence = {
  path: string;
  sha256: string;
};

export type EditingAppSpikeCheck = {
  status: "passed" | "failed" | "not_run";
  evidence: EditingAppSpikeEvidence[];
  notes?: string;
};

export type EditingAppSpikeReport = {
  version: 1;
  id: string;
  testedAt: string;
  app: {
    kind: EditingAppKind;
    name: string;
    bundleId: string;
    version: string;
    build: string;
    appPath: string;
  };
  draft: {
    rootPath: string;
    isolatedDraftPath: string;
  };
  fixture: {
    id: string;
    manifestPath: string;
    sha256: string;
  };
  checks: Partial<Record<EditingAppSpikeCheckKey, EditingAppSpikeCheck>>;
};

export type EditingAppSpikeArtifactProbe = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  isFile: boolean;
  sha256?: string;
};

export type EditingAppSpikeDraftProbe = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
};

export type EditingAppSpikeValidationIssue = {
  code: string;
  severity: "warning" | "error";
  message: string;
  check?: EditingAppSpikeCheckKey;
  path?: string;
};

export type EditingAppSpikeValidation = {
  valid: boolean;
  reportId: string;
  passedCheckCount: number;
  requiredCheckCount: number;
  target?: VerifiedEditingAppTarget;
  issues: EditingAppSpikeValidationIssue[];
};

function addIssue(
  issues: EditingAppSpikeValidationIssue[],
  code: string,
  severity: EditingAppSpikeValidationIssue["severity"],
  message: string,
  extra: Pick<EditingAppSpikeValidationIssue, "check" | "path"> = {},
): void {
  issues.push({ code, severity, message, ...extra });
}

function nonEmpty(value: unknown): string {
  return String(value || "").trim();
}

function validSha256(value: unknown): value is string {
  return /^[a-f0-9]{64}$/i.test(nonEmpty(value));
}

function safeRelativePath(value: unknown): value is string {
  const text = nonEmpty(value);
  return Boolean(text)
    && !text.includes("\0")
    && !path.isAbsolute(text)
    && !text.split(/[\\/]/).includes("..");
}

function samePath(left: string, right: string): boolean {
  if (!nonEmpty(left) || !nonEmpty(right)) return false;
  return path.resolve(left) === path.resolve(right);
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  if (!nonEmpty(parentPath) || !nonEmpty(childPath)) return false;
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function validateEditingAppSpikeReport(
  report: EditingAppSpikeReport,
  environment: EditingAppEnvironmentReport,
  artifacts: EditingAppSpikeArtifactProbe[],
  isolatedDraftProbe: EditingAppSpikeDraftProbe,
): EditingAppSpikeValidation {
  const issues: EditingAppSpikeValidationIssue[] = [];
  const reportId = nonEmpty(report?.id);
  if (report?.version !== 1) {
    addIssue(issues, "REPORT_VERSION_UNSUPPORTED", "error", "Spike report.version 必须为 1。");
  }
  if (!reportId) {
    addIssue(issues, "REPORT_ID_MISSING", "error", "Spike report 缺少稳定 id。");
  }
  if (!nonEmpty(report?.testedAt) || !Number.isFinite(Date.parse(report.testedAt))) {
    addIssue(issues, "TESTED_AT_INVALID", "error", "testedAt 必须是有效 ISO 时间。");
  }

  const app = report?.app;
  if (
    !app
    || (app.kind !== "jianying" && app.kind !== "capcut")
    || !nonEmpty(app.name)
    || !nonEmpty(app.bundleId)
    || !nonEmpty(app.version)
    || !nonEmpty(app.build)
    || !path.isAbsolute(nonEmpty(app.appPath))
  ) {
    addIssue(
      issues,
      "APP_IDENTITY_INVALID",
      "error",
      "报告必须包含应用类型、名称、bundle ID、精确版本和绝对安装路径。",
    );
  }
  if (environment.readiness !== "ready_for_spike") {
    addIssue(
      issues,
      "ENVIRONMENT_NOT_READY",
      "error",
      `当前环境状态为 ${environment.readiness}，不能验证真机报告。`,
    );
  }
  const installation = app
    ? environment.installations.find((item) =>
      item.kind === app.kind
      && item.name === app.name
      && item.bundleId === app.bundleId
      && item.version === app.version
      && nonEmpty(item.build) === nonEmpty(app.build)
      && samePath(item.appPath, app.appPath))
    : undefined;
  if (!installation) {
    addIssue(
      issues,
      "APP_ENVIRONMENT_MISMATCH",
      "error",
      "报告中的应用名称、类型、bundle、版本、build 或安装路径与当前探测结果不一致。",
    );
  }

  const draft = report?.draft;
  const rootPath = nonEmpty(draft?.rootPath);
  const isolatedDraftPath = nonEmpty(draft?.isolatedDraftPath);
  if (
    !path.isAbsolute(rootPath)
    || !path.isAbsolute(isolatedDraftPath)
    || !isStrictDescendant(rootPath, isolatedDraftPath)
  ) {
    addIssue(
      issues,
      "ISOLATED_DRAFT_PATH_INVALID",
      "error",
      "隔离测试草稿必须是草稿根目录下的新子目录，不能等于或越出根目录。",
    );
  }
  if (
    !samePath(isolatedDraftProbe?.path || "", isolatedDraftPath)
    || !isolatedDraftProbe?.exists
    || !isolatedDraftProbe?.isDirectory
  ) {
    addIssue(
      issues,
      "ISOLATED_DRAFT_NOT_FOUND",
      "error",
      "报告中的隔离测试草稿目录不存在。",
      { path: isolatedDraftPath || undefined },
    );
  }
  const detectedRoot = app
    ? environment.draftRoots.find((root) =>
      root.kind === app.kind
      && samePath(root.path, rootPath)
      && root.exists
      && root.isDirectory
      && root.readable
      && root.writable)
    : undefined;
  if (!detectedRoot) {
    addIssue(
      issues,
      "DRAFT_ROOT_ENVIRONMENT_MISMATCH",
      "error",
      "报告中的草稿根目录不在当前可读写探测结果中。",
      { path: rootPath || undefined },
    );
  }

  const artifactByPath = new Map(
    artifacts.map((artifact) => [artifact.relativePath, artifact]),
  );
  const fixturePath = nonEmpty(report?.fixture?.manifestPath);
  if (
    !nonEmpty(report?.fixture?.id)
    || !safeRelativePath(fixturePath)
    || !validSha256(report?.fixture?.sha256)
  ) {
    addIssue(
      issues,
      "FIXTURE_IDENTITY_INVALID",
      "error",
      "固定用例必须包含 fixture id、相对 manifest 路径和 SHA-256。",
      { path: fixturePath || undefined },
    );
  } else {
    const fixtureProbe = artifactByPath.get(fixturePath);
    if (
      !fixtureProbe
      || !fixtureProbe.exists
      || !fixtureProbe.isFile
      || fixtureProbe.sha256?.toLocaleLowerCase()
        !== report.fixture.sha256.toLocaleLowerCase()
    ) {
      addIssue(
        issues,
        "FIXTURE_ARTIFACT_MISMATCH",
        "error",
        "固定用例 manifest 缺失或 SHA-256 不一致。",
        { path: fixturePath },
      );
    }
  }

  let passedCheckCount = 0;
  for (const key of REQUIRED_EDITING_APP_SPIKE_CHECKS) {
    const check = report?.checks?.[key];
    if (!check) {
      addIssue(issues, "SPIKE_CHECK_MISSING", "error", "缺少必需的真机检查。", {
        check: key,
      });
      continue;
    }
    if (check.status !== "passed") {
      addIssue(
        issues,
        check.status === "failed" ? "SPIKE_CHECK_FAILED" : "SPIKE_CHECK_NOT_RUN",
        "error",
        check.status === "failed" ? "真机检查失败。" : "真机检查尚未执行。",
        { check: key },
      );
      continue;
    }
    const evidence = Array.isArray(check.evidence) ? check.evidence : [];
    if (evidence.length === 0) {
      addIssue(
        issues,
        "SPIKE_EVIDENCE_MISSING",
        "error",
        "已通过的检查必须至少附带一个本地证据文件。",
        { check: key },
      );
      continue;
    }
    const seenPaths = new Set<string>();
    let evidenceValid = true;
    for (const item of evidence) {
      const evidencePath = nonEmpty(item?.path);
      if (
        !safeRelativePath(evidencePath)
        || !validSha256(item?.sha256)
        || seenPaths.has(evidencePath)
      ) {
        addIssue(
          issues,
          "SPIKE_EVIDENCE_IDENTITY_INVALID",
          "error",
          "证据路径必须安全、唯一，并包含 SHA-256。",
          { check: key, path: evidencePath || undefined },
        );
        evidenceValid = false;
        continue;
      }
      seenPaths.add(evidencePath);
      const probe = artifactByPath.get(evidencePath);
      if (
        !probe
        || !probe.exists
        || !probe.isFile
        || probe.sha256?.toLocaleLowerCase() !== item.sha256.toLocaleLowerCase()
      ) {
        addIssue(
          issues,
          "SPIKE_EVIDENCE_ARTIFACT_MISMATCH",
          "error",
          "证据文件缺失或 SHA-256 不一致。",
          { check: key, path: evidencePath },
        );
        evidenceValid = false;
      }
    }
    if (evidenceValid) passedCheckCount += 1;
  }

  const valid = !issues.some((issue) => issue.severity === "error");
  return {
    valid,
    reportId,
    passedCheckCount,
    requiredCheckCount: REQUIRED_EDITING_APP_SPIKE_CHECKS.length,
    ...(valid && app
      ? {
        target: {
          kind: app.kind,
          bundleId: app.bundleId,
          version: app.version,
          build: app.build,
          reportId,
          testedAt: report.testedAt,
        },
      }
      : {}),
    issues,
  };
}
