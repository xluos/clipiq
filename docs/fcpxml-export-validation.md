# FCPXML 粗剪时间线导出验证

更新时间：2026-07-24

## 结论

ClipIQ 的可移植素材包现在固定包含 `timeline.fcpxml`。该文件直接由已通过校验的 `EditPlan` 生成，使用 FCPXML 1.10，引用素材包内已经复制的媒体文件，不引入第二套剪辑数据模型。

当前覆盖：

- 主视频片段顺序、源入点、源出点和时间线位置。
- 使用 `timeMap` 表达的恒定变速，并保留音频音高。
- 原视频音量。
- 有实际音频文件的原声、BGM 和 TTS 配音轨，包含位置、源区间、音量和角色。
- 画布宽高、帧率、项目总时长。
- 中文、空格和 XML 特殊字符路径。

明确降级：

- 非硬切转场先线性化为硬切。
- 字幕继续以 `captions.srt` 交付，不写入 FCPXML caption 元素。
- 贴图和花字资源保留在素材包，不写入 FCPXML。
- `EditPlan.crop` 目前缺少原素材宽高，不能可靠换算为 FCPXML 百分比裁切；人物智能构图以 `preview.mp4` 为准。
- 音频淡入淡出和 ducking 不写入，只保留位置和基础音量。

每项降级都会写入 `manifest.json.warnings`，不能静默丢失。

## 产物

```text
export-package/
├── edit-plan.json
├── timeline.fcpxml
├── manifest.json
├── captions.srt
├── media/
├── audio/
├── overlays/
└── preview.mp4
```

`timeline.fcpxml` 中的 `media-rep.src` 使用导出完成后目录的绝对 `file:` URL。首次导入可以直接定位素材；如果用户之后移动整个素材包，应在目标剪辑软件中重新链接媒体。相对路径的 `edit-plan.json` 和素材包本身仍保持可移植。

## 自动验证

对应测试：

- `test/fcpxml-exporter.test.ts`
  - FCPXML 1.10 根结构和画布格式。
  - 微秒到有理数秒的稳定换算。
  - 中文、空格、`& < > "` 的 URL 和 XML 转义。
  - 源裁切区间、时间线位置、恒定变速 `timeMap`。
  - 音频角色、音量和降级 warning。
  - 重叠转场降级后的线性时间线。
- `test/edit-package-exporter.test.ts`
  - `timeline.fcpxml` 原子写入素材包。
  - 文件大小、SHA-256 和引用项进入 manifest。
  - 重复导出不覆盖已有目录。

验证命令：

```bash
npm test -- --run test/fcpxml-exporter.test.ts test/edit-package-exporter.test.ts
npm test
npm run lint
npm run build
```

## 未完成的外部验收

当前机器没有 Final Cut Pro，因此还没有宣称完成真实导入、重新链接、保存和重开验证。首次具备 Final Cut Pro 环境时，应固定验证：

1. 30 fps 与 29.97 fps 项目。
2. 两段硬切和一段 0.95～1.05 倍变速。
3. 原声、BGM、TTS 三类音频。
4. 中文和空格路径。
5. 导入后源入点、源出点和音频时间误差不超过一帧。
6. 保存、退出、重开后素材仍在线。

真机验证失败不影响 `EditPlan`、代理预览或素材包；FCPXML 只是一个可替换的导出适配器。
