# 贴纸与花字模板验证

## 范围

首批模板只解决可执行、可预览、可移植的基础视觉层，不做自动贴纸选择，也不接入未经剪映真机验证的资源 ID：

- `clipiq.flower.punch.v1`：重点花字，最多 18 个字符。
- `clipiq.flower.note.v1`：注释花字，最多 24 个字符。
- `clipiq.sticker.spark.v1`：矢量闪光贴纸。

模板注册表保存版本、类型、文本约束、默认时长、变换、动画和中立 ASS 样式。Renderer 只读取公开的标签、说明和输入约束。

## 时间与版本契约

- `OverlayItem` 可保存 `text / resourceKey / anchorClipId / anchorOffsetUs`。
- Studio 通过结构化反馈添加或移除模板，每次生成不可变的 `EditPlan revision`。
- 模板以视频片段 ID 锚定；镜头重排后重新计算时间，缩短时裁到镜头尾部，删除锚定镜头时一并移除。
- 花字空文本、超长文本、无效变换、时间越界和不存在的锚点会阻止计划通过校验。
- 未知 `resourceKey` 作为旧计划或外部模板引用保留，并产生 warning；代理预览跳过，不伪造替代资源。

## 代理预览

代理渲染器将基础字幕、花字和矢量贴纸合并为同一份 ASS：

- 花字使用系统中文字体、确定性位置和配色。
- 贴纸使用 ASS 矢量路径，不依赖外部图片或网络资源。
- 支持 `pop / fade` 两种受控动画。
- 即使字幕选择外挂 SRT 或关闭字幕，视觉模板仍会烧入预览。
- FFmpeg 缺少 `subtitles` filter 时保留外挂字幕并明确报告视觉模板已跳过。

运行时验证：

```bash
npm run vlog:validate-overlay-templates
```

该命令生成两秒黑场素材，经正式代理渲染器烧入重点花字和闪光贴纸，再抽取 RGB 帧。验证要求非黑通道超过 1,000，证明模板确实进入视频像素；2026-07-24 本机结果为 76,379，且无 warning。

## 素材包

使用到内建模板时，素材包写入：

```text
overlays/templates.json
```

文件包含版本化的中立模板定义，并在 manifest 中以 `overlay_template` 记录 SHA-256 和引用项。自定义图片照常复制到 `overlays/`；未知且无本地资源的模板仍产生 `OVERLAY_RESOURCE_NOT_PORTABLE`。

FCPXML 当前不写入视觉模板，继续产生 `FCPXML_OVERLAY_NOT_INCLUDED`，由代理预览和素材包保留视觉结果与模板定义。

## 自动化覆盖

```bash
npm test -- --run \
  test/overlay-templates.test.ts \
  test/proxy-renderer.test.ts \
  test/edit-plan-feedback.test.ts \
  test/edit-package-exporter.test.ts \
  test/contract.test.ts \
  electron/preload.smoke.test.js
```

覆盖模板注册表、文本边界、镜头重排与删除、ASS 花字/矢量事件、未知模板降级、素材包模板清单和 IPC 三层契约。

浏览器验证覆盖 Studio 会话异步回填、模板选择、花字输入、revision 更新、移除和 1728px 视口无横向溢出。
