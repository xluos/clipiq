# 分段事件语义与 Vlog 质量评估

更新时间：2026-07-24

## 目标

让剪辑依据能够明确区分：

- 某个具体时间段发生的事件。
- 只能覆盖整段 Shot 的降级描述。
- 字幕、人物和说话人各自独立的时间证据。

同时用程序化指标验证候选绑定、时间范围、人物一致性和真实编辑反馈，不把“模型觉得不错”当作质量结论。

## 事件语义数据流

`buildShotsFromAnalysis` 将 `AnalysisNode.startSec/endSec` 与每个 `ShotContext` 求交：

1. 收集 Shot 内所有有效分析节点。
2. 以节点起止时间切成连续原子区间。
3. 只有节点自身能形成 Shot 内部边界时，才进入分段语义候选；覆盖整 Shot 的节点只作为降级描述。
4. 同一区间存在多个分段节点时，依次按置信度、范围精度和稳定 ID 选择，并写入 `granularity: "segment"`。
5. 没有内部边界或存在未覆盖区间时，使用 `Shot.description` 并写入 `granularity: "shot"`。

结果持久化在 `shots.event_segments`：

```ts
type ShotEventSegment = {
  startSec: number;
  endSec: number;
  summary: string;
  granularity: "shot" | "segment";
  source: "analysis_node" | "shot_description";
  sourceNodeId?: string;
  confidence?: number;
};
```

Candidate Builder 会把事件分段裁切到每个确定性候选窗口。`EditPlan.VideoClip.evidence` 同时保留：

- 窗口级 `eventSummary`。
- 可追溯的 `eventSegments`。
- 连续 `alignedSegments` 中的 `event@segment` 或 `event@shot`。

Planner 只能把 `event@segment` 当作具体时间段语义；`event@shot` 不能被解释为逐秒视觉结论。

## 证据质量

`AnalysisEvidenceQualityReport.semantic` 记录：

- `capability`: `none / shot / segment`。
- Shot 描述覆盖率。
- 有效事件分段数和非法分段数。
- 分段级事件数量。
- 分段级事件覆盖总 Shot 时长的比例。

Studio 显示“分段 xx%”“镜头 xx%”或“无”。旧报告没有 `capability` 时按镜头级兼容显示。

## 质量评估器

`electron/editing/vlog-quality-evaluator.ts` 对同一固定输入计算：

- 候选 ID、Shot、素材和候选来源范围绑定错误率。
- 视频片段越过真实 Shot 的比例。
- 字幕和事件语义分段越界率。
- FFmpeg 预览成功率。
- 剪映草稿打开成功率；未实测时为 `null`，不能记作通过。
- 跨素材实际参与比较的 pair 数，以及同人物 pair recall / precision。
- 不同人物被自动合并的 pair 数，目标为 `0`。
- 初始镜头保留比例、移动比例、替换比例和达到当前版本前的操作数。

任何已测硬门禁失败时报告为 `failed`；全部已测门禁通过但仍有剪映或人物真值未评估时为 `partial`。

## 自动验证

```bash
npm test -- \
  test/analysis-shot-sync.test.ts \
  test/aligned-evidence.test.ts \
  test/analysis-evidence-quality.test.ts \
  test/vlog-quality-evaluator.test.ts
```

覆盖 Shot 内多事件切分、Shot 级降级、数据库往返、候选窗口裁切、EditPlan 证据、非法范围、人物错误合并和未实测门禁。

## 固定真人素材状态

仓库不提交真人视频或人物真值。当前自动化使用确定性的结构化夹具验证计算口径；10～20 条生活素材、跨素材同人物标注和剪映打开结果仍需在仓库外建立固定本地集后录入。

固定集未建立前：

- 不声称跨素材人物召回率已达标。
- 不声称剪映草稿打开率为 100%。
- 不用现有账号下载视频替代经过同意和标注的生活素材。
