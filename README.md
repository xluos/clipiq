<div align="center">
  <img src="public/logo.png" alt="ClipIQ" width="120" height="120" />
  <h1>ClipIQ</h1>
  <p><em>看懂每一帧的逻辑</em></p>
</div>

ClipIQ 是一个本地优先的 Electron 桌面应用，把视频自动跑成一份可读的拉片报告：

视频 / 链接 → 抽帧 + 字幕 → LLM 拉片 → 节点时间轴 + 方法论审计 + 弹幕情绪。

## 主要能力

- **本地 / 链接双入口**：拖入文件、粘贴 yt-dlp 支持的链接、或直接输入本地路径。
- **金字塔分析管线**：帧描述 → 镜头合并 → 全局聚合 → 主分析评审，所有阶段带缓存。
- **本地推理可选**：内置 llama.cpp + whisper.cpp sidecar，按机器规格做 fit/tps 评估，模型 manifest 化加 GGUF 校验与断点续传。
- **远程 provider**：通用 OpenAI-compatible 接口，6 槽位任务分配按"视觉 / 音频 / 文本 / 推理"分发到不同模型。
- **B 站弹幕**：protobuf 拉取 + 情绪桶聚合 + 词云生成。
- **后台运行**：长任务挂托盘 + 系统通知，关窗不退出。

## 下载

预编译产物从 [Releases](https://github.com/xluos/clipiq/releases) 获取：

- **macOS**：`ClipIQ-<version>-arm64.dmg`（Apple Silicon）/ `ClipIQ-<version>-x64.dmg`（Intel）。未签名，首次打开右键 → 打开。
- **Windows**：`ClipIQ Setup <version>.exe`（x64）。未签名，会触发 SmartScreen 警告，选"仍要运行"。

首次启动会下载 yt-dlp；本地推理模型按需在"设置 → 本地推理"里拉。

## 本地开发

需要 Node.js ≥ 20。

```bash
npm install
npm run electron:dev      # Vite + Electron, renderer 走 HMR
```

其他常用命令：

| 命令 | 说明 |
|---|---|
| `npm run dev` | 仅前端（端口 5757），无 Electron 能力，做 UI 预览 |
| `npm run electron:preview` | 生产 build + Electron，验真实加载方式 |
| `npm run lint` | `tsc --noEmit` 类型检查 |
| `npm run dist` | 本机平台打包，产物在 `release/` |
| `npm run dist:mac` / `dist:win` | 指定平台打包 |

修改 `electron/*.cjs`（main / preload / runtime）必须 kill 当前进程重启，Vite HMR 不会重载 main 进程。

## 架构入口

| 关注点 | 文件 |
|---|---|
| 屏幕路由 / 全局状态 | `src/AppContext.tsx` |
| IPC 暴露面 | `electron/preload.cjs` + `src/electron-api.d.ts` |
| 主进程编排 | `electron/main.cjs` |
| 本地 LLM sidecar | `electron/llama-runtime.cjs` |
| 本地 ASR sidecar | `electron/whisper-cpp-runtime.cjs` |
| 模型管理 daemon | `electron/daemon-client.cjs` → ai-model-daemon |
| 本地模型清单 | `electron/local-models.manifest.cjs` |
| 设计系统 | `DESIGN.md` |
| 产品规划 | `PRODUCT.md` |

更详细的项目约束、命令、UI 文案规则见 `CLAUDE.md`。

## 数据路径

macOS：`~/Library/Application Support/clipiq/`

- `config.json` — provider / 任务分配 / 默认分析
- `data.db` — 项目元数据
- `projects/<projectId>/` — 抽帧 / 字幕 / 分析产物
- `models/llama/` `models/whisper/` — 本地模型权重
- `bin/` `sidecars/` — sidecar 二进制与 PID 文件

## License

待定。
