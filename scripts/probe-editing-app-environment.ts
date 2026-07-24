#!/usr/bin/env node

import {
  detectEditingAppEnvironment,
} from "../electron/editing/editing-app-environment";

function usage(): string {
  return [
    "用法：npm run vlog:probe-editing-app -- [--json]",
    "",
    "只读探测 macOS 上的剪映专业版 / CapCut 安装、版本和已有草稿根目录。",
    "不会启动应用、创建目录或修改草稿。",
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const report = detectEditingAppEnvironment();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const readinessText = {
      unsupported_platform: "当前平台未支持",
      not_installed: "未检测到应用",
      app_detected: "检测到应用，草稿环境未就绪",
      ready_for_spike: "可开始隔离真机 Spike",
    }[report.readiness];
    console.log(`剪辑应用环境：${readinessText}`);
    console.log(`正式 exporter：${report.exporterReady ? "可用" : "锁定"}`);
    for (const installation of report.installations) {
      console.log(
        `${installation.kind === "jianying" ? "剪映" : "CapCut"} · `
        + `${installation.version || "版本未知"} · `
        + `${installation.compatibility === "verified" ? "已验证" : "未验证"}`,
      );
      console.log(`  ${installation.appPath}`);
    }
    for (const root of report.draftRoots.filter((item) => item.exists)) {
      console.log(
        `草稿根目录 · ${root.kind} · ${root.projectCount} 个项目 · `
        + `${root.writable ? "可写" : "不可写"}`,
      );
      console.log(`  ${root.path}`);
    }
    for (const issue of report.issues) {
      console.log(`${issue.severity.toUpperCase()} ${issue.code}：${issue.message}`);
    }
  }
  if (report.readiness !== "ready_for_spike") process.exitCode = 1;
}

main();
