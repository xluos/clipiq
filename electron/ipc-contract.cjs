// ───────────────────────────────────────────────────────────────────────────
// IPC 契约 —— main.cjs 和测试的入口。
//
// 真正的 manifest(CHANNELS / entryKey)定义在 preload.cjs,原因见那里:
// Electron sandbox 下 preload 不能 require 本地文件,只能自包含;为避免重复定义,
// 反过来由本文件从 preload re-export,并派生出 main 启动校验用的 channel 列表。
//
// 注意:require("./preload.cjs") 会执行 preload 模块体,但其自执行块用
// contextBridge?.exposeInMainWorld 守卫 —— 在主进程 / 测试里 contextBridge 为
// undefined,不会真的 expose,安全。
// ───────────────────────────────────────────────────────────────────────────

const { CHANNELS, entryKey } = require("./preload.cjs");

// main 启动 fail-fast 用:所有需要 ipcMain.handle 的 channel
const INVOKE_CHANNELS = CHANNELS.filter((c) => c.kind === "invoke").map((c) => c.channel);
// main→renderer 推送的 channel(需要 send/broadcast 发射)
const EVENT_CHANNELS = CHANNELS.filter((c) => c.kind === "event").map((c) => c.channel);

module.exports = { CHANNELS, INVOKE_CHANNELS, EVENT_CHANNELS, entryKey };
