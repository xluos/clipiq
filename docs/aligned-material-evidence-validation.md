# 素材时间片证据验证

更新时间：2026-07-24

## 目标

将同一 Shot 内原本分散的事件描述、字幕、人物出镜和说话人轨迹按真实素材时间边界对齐，让 Planner 不再自行猜测“某一秒谁在画面里、谁在说什么”。

## 数据契约

`VideoClipEvidence.alignedSegments` 连续覆盖视频片段的 `sourceInUs` 到 `sourceOutUs`。每个时间片包含：

- 微秒级 `startUs / endUs`。
- 当前 Shot 的事件描述，并以 `eventGranularity: "shot"` 明确语义精度。
- 当前时间片内重叠的字幕和字幕粒度。
- 当前出镜记录的 `appearanceId / trackId`，仅在身份可信或人工确认时携带 `personId`。
- 当前说话轨迹的 `trackId / speakerId`，仅在已有可靠关联时携带 `personId`。

时间片边界由以下证据的起止时间并集确定：

- 视频片段范围。
- 字幕分段。
- 人物出镜区间。
- 说话人区间。

相邻时间片只有在全部证据负载一致时才合并。

## 人物一致性

- `trackId` 只保证单素材内连续，不用于跨素材判断。
- SFace 聚类达到阈值或人工确认后，不同素材中的出镜记录复用同一 `personId`。
- 低置信度人物只保留匿名 `trackId`，不会因为同时出镜或同时说话而自动获得身份。
- `speakerId` 和 `personId` 继续分离；没有显式关联时，Planner 不得把说话人推断为画面中的人物。

## Planner 与 EditPlan

- Candidate Builder 为每个真实 Shot 生成完整时间片。
- Planner prompt 使用 `alignedTimeline`，逐片提供事件、字幕、出镜人物和说话人。
- `event@shot` 明确事件描述仍是 Shot 粒度，避免伪装为逐秒视觉理解。
- 编译后的 `EditPlan` 保留完整 `alignedSegments`，供后续剪辑反馈、关键词高亮和导出使用。
- Planner 输入摘要现在包含事件、字幕、人物和说话人证据；任一证据变化都会改变摘要。
- 镜头缩短后重新裁切并构建时间片，校验器要求时间片连续覆盖新来源范围，且人物和说话人引用可追溯。

## 自动验证

```bash
npm test -- --run \
  test/aligned-evidence.test.ts \
  test/vlog-candidate-planner.test.ts \
  test/edit-plan.test.ts \
  test/edit-plan-feedback.test.ts
```

覆盖：

- 字幕、人物、说话人边界的原子切分与相邻合并。
- 未知人物保持匿名。
- 同一可信人物跨素材复用稳定 `personId`，同时保留各自 `trackId`。
- Planner 收到对齐后的时间片文本。
- EditPlan 写入时间片并校验连续性和引用关系。
- 裁切后时间片和字幕证据同步收缩。
- 事件或人物证据变化会改变 Planner 输入摘要。

## 当前边界

- 事件语义来自 Shot 描述，时间精度是 Shot 级；尚未额外运行逐秒视觉语义模型。
- 字幕精度由实际转写能力决定。词级覆盖不足时仍显式降级为分段级。
- 自动说话人到人物关联尚不使用口型模型或跨素材声纹；证据不足时保持未关联。
- 侧脸、遮挡、强光、多人重叠和跨设备素材仍可能把同一人物拆为多个匿名人物，优先避免误合并。
