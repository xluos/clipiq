import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 单 config + 按路径切 environment:
//   src/**     → jsdom (前端 store / hook / 订阅,需要 window)
//   electron/**→ node  (后端纯 .cjs 模块)
//   test/**    → node  (IPC 契约测试,读源码文件做静态比对)
export default defineConfig({
  // vitest 自带一份 vite,与项目 vite 类型不同源,react() 插件类型对不上 —— 纯工具链冲突,cast 掉。
  plugins: [react()] as never,
  test: {
    environmentMatchGlobs: [
      ["src/**", "jsdom"],
      ["electron/**", "node"],
      ["test/**", "node"],
    ],
    setupFiles: ["./test/setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "electron/**/*.test.{js,cjs}",
      "test/**/*.test.ts",
    ],
  },
});
