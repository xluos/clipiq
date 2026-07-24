# 情绪段落 BGM 验证

## 数据边界

情绪字段表示剪辑意图，不表示素材中人物的客观心理状态。Planner 只能依据候选窗口已有的事件、字幕和剪辑作用输出：

- `tone`: `neutral / calm / warm / upbeat / tense / reflective`
- `intensity`: 0～1
- `confidence`: 0～1
- `reason`: 不超过 40 个字符的依据

人物、字幕、事件、说话人仍由分析证据提供。Planner 不得用情绪字段补写素材中不存在的事实。

## 确定性编排

`buildEmotionSegments` 按成片镜头顺序：

1. 合并连续同类情绪。
2. 对短于 3 秒的段落选择强度最接近的相邻段落合并。
3. 段落超过 4 个时，优先合并最短段落。
4. 保证段落从 `0` 连续覆盖到 `actualDurationUs`。

每段保留镜头 ID、加权强度、加权置信度和 Planner 依据。`EditPlan` 校验器拒绝时间空洞、重复镜头、无效分值，以及 BGM 与情绪段落的起点、时长或标签不一致。

## Studio 行为

- 选择 1 个音频文件：作为全片 BGM。
- 选择多个音频文件：文件数必须等于情绪段落数，并按文件名的自然排序依次映射；可用 `01-`、`02-` 前缀明确顺序。
- 每段显示文件名、情绪、成片时间范围和可用 BPM。
- 每段可独立移除，重新选择会原子替换整组 BGM。
- 当前版本不自动分析歌曲情绪，也不自动从曲库选歌。

## 代理预览

FFmpeg 对每段音频独立执行：

- source trim
- volume
- fade in / fade out
- timeline delay
- voiceover ducking
- 与原声统一混音

音频短于情绪段落时保留尾部原声并给出 warning；单首全片 BGM 超出成片时按时间线截断。

## 自动验证

```bash
npm test -- --run \
  test/vlog-candidate-planner.test.ts \
  test/edit-plan.test.ts \
  test/edit-plan-feedback.test.ts \
  test/emotion-segments.test.ts \
  test/proxy-renderer.test.ts
```

覆盖：

- Planner 情绪 schema、解析和非法输出拒绝。
- 镜头情绪进入 `EditPlan` 并生成连续段落。
- 短段合并、最多四段和镜头覆盖。
- 多段 BGM 一一映射与整组反馈。
- FFmpeg 多输入裁切、淡入淡出、时间延迟和混音参数。

真实 FFmpeg 验证使用两段本地生成音频，分别放置在 `0–4s` 和 `4–8s`，输出保留 8 秒视频和连续音轨。
