# 确定性子镜头候选验证

更新时间：2026-07-24

## 目标

长 Shot 不再默认从开头裁切。程序先依据已对齐的字幕、人物和说话人证据边界生成固定来源范围，再让 Planner 只选择不可修改的 `candidateId`。

## 契约

每个候选窗口包含：

- 稳定 `candidateId`：`<shotId>::<startUs>-<endUs>`。
- 来源 `shotId / videoId`。
- 程序确定的整数微秒 `startUs / endUs`。
- 该范围内重新裁切后的字幕、人物、说话人和 `alignedSegments`。
- 边界来源：完整 Shot、证据边界或最大时长。

Planner 只能输出：

```json
{
  "selections": [
    {
      "candidateId": "shot-long::5000000-9000000",
      "intent": "保留到达后的关键对白",
      "confidence": 0.9
    }
  ],
  "voiceover": [
    {
      "afterCandidateId": "shot-long::5000000-9000000",
      "text": "真正的挑战才刚开始。"
    }
  ]
}
```

Planner 仍不得输出来源路径或任意起止时间。Parser 将 `candidateId` 解析回候选中的 `shotId`，编译器再次校验候选范围没有越过 Shot。

## 窗口规则

- 默认最大窗口为 6 秒。
- 默认最小切分窗口为 0.8 秒。
- 短 Shot 保持完整，不制造无意义切分。
- 长 Shot 优先选择最大时长内最靠后的字幕、人物或说话人边界。
- 没有合适证据边界时按最大时长切分。
- 尾段不足最小时长时，前一个边界向前调整，保证连续完整覆盖。
- 同一 Shot 可以产生并选择多个不重叠窗口，支持保留长镜头中的不同对白或动作阶段。

## 全链路

- 初次生成：Candidate Builder 生成窗口，Planner 返回 `candidateId`，Compiler 写入精确 `sourceInUs / sourceOutUs`。
- 字幕与人物：每个窗口只携带自身范围内的对齐证据。
- 旁白：使用 `afterCandidateId` 锚定已选择窗口，避免同一 Shot 多次出现时产生歧义。
- 替换镜头：Studio 提交具体 `replacementCandidateId`，后端重新构建候选并按 ID 解析，不信任客户端传入时间。
- 旧 EditPlan：没有 `candidateId` 时保留可编辑兼容 warning；新生成或替换的片段会补齐。

## 自动验证

```bash
npm test -- --run \
  test/candidate-windows.test.ts \
  test/vlog-candidate-planner.test.ts \
  test/edit-plan.test.ts \
  test/edit-plan-feedback.test.ts
```

覆盖：

- 短 Shot 保持完整。
- 长 Shot 优先按真实证据边界切分。
- 无证据时固定时长降级。
- 尾段最小时长和连续覆盖。
- 非法或重复 `candidateId` 被拒绝。
- 同一 Shot 的多个候选可编译为不同来源范围。
- 字幕只进入实际选中的窗口。
- 替换操作只接受已解析的 `replacementCandidateId`。
- 旁白只能引用已选择且非末尾的候选窗口。
