#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  detectEditingAppEnvironment,
} from "../electron/editing/editing-app-environment";
import {
  validateEditingAppSpikeReport,
  type EditingAppSpikeArtifactProbe,
  type EditingAppSpikeReport,
} from "../electron/editing/editing-app-spike-report";

function usage(): string {
  return [
    "用法：npm run vlog:validate-jianying-spike -- <report.json> [--json]",
    "",
    "在当前机器重新探测应用和草稿目录，并校验九项真机证据及 SHA-256。",
    "命令只读文件，不会启动应用、创建目录或修改草稿。",
  ].join("\n");
}

function safeRelativePath(value: unknown): value is string {
  const text = String(value || "").trim();
  return Boolean(text)
    && !text.includes("\0")
    && !path.isAbsolute(text)
    && !text.split(/[\\/]/).includes("..");
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function probeArtifacts(
  report: EditingAppSpikeReport,
  reportDir: string,
): Promise<EditingAppSpikeArtifactProbe[]> {
  const relativePaths = new Set<string>();
  const fixturePath = String(report?.fixture?.manifestPath || "").trim();
  if (safeRelativePath(fixturePath)) relativePaths.add(fixturePath);
  for (const check of Object.values(report?.checks || {})) {
    const evidenceItems = Array.isArray(check?.evidence) ? check.evidence : [];
    for (const evidence of evidenceItems) {
      const evidencePath = String(evidence?.path || "").trim();
      if (safeRelativePath(evidencePath)) relativePaths.add(evidencePath);
    }
  }

  return Promise.all([...relativePaths].map(async (relativePath) => {
    const absolutePath = path.resolve(reportDir, relativePath);
    let exists = false;
    let isFile = false;
    let digest: string | undefined;
    try {
      const lstat = lstatSync(absolutePath);
      exists = true;
      isFile = !lstat.isSymbolicLink() && lstat.isFile();
      if (isFile) digest = await sha256(absolutePath);
    } catch {
      // 缺失或不可读会由纯校验器产出稳定错误码。
    }
    return {
      relativePath,
      absolutePath,
      exists,
      isFile,
      ...(digest ? { sha256: digest } : {}),
    };
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== 1 || args.some((arg) =>
    arg.startsWith("-") && arg !== "--json")) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const reportPath = path.resolve(positional[0]);
  let report: EditingAppSpikeReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as EditingAppSpikeReport;
  } catch (error) {
    console.error(
      `无法读取 Spike report：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  const environment = detectEditingAppEnvironment();
  const artifacts = await probeArtifacts(report, path.dirname(reportPath));
  const isolatedDraftPath = String(report?.draft?.isolatedDraftPath || "").trim();
  let exists = false;
  let isDirectory = false;
  try {
    exists = existsSync(isolatedDraftPath);
    isDirectory = exists && statSync(isolatedDraftPath).isDirectory();
  } catch {
    // 缺失或不可读会由纯校验器产出稳定错误码。
  }
  const result = validateEditingAppSpikeReport(
    report,
    environment,
    artifacts,
    {
      path: isolatedDraftPath,
      exists,
      isDirectory,
    },
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify({ environment, artifacts, result }, null, 2));
  } else {
    console.log(
      `真机 Spike：${result.valid ? "通过" : "未通过"}`
      + ` · ${result.passedCheckCount}/${result.requiredCheckCount} 项证据有效`,
    );
    console.log(`报告：${result.reportId || "缺少 id"}`);
    console.log(`当前环境：${environment.readiness}`);
    for (const issue of result.issues) {
      const target = [
        issue.check ? `check=${issue.check}` : "",
        issue.path ? `path=${issue.path}` : "",
      ].filter(Boolean).join(" · ");
      console.log(
        `${issue.severity.toUpperCase()} ${issue.code}：${issue.message}`
        + (target ? `（${target}）` : ""),
      );
    }
  }
  if (!result.valid) process.exitCode = 1;
}

void main();
