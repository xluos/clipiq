# M0-3 时序证据与人物身份 Spike

> 日期：2026-07-24
> 结论：ClipIQ 当前可提供分段级字幕与镜头内容证据；词级时间戳、通用说话人分离、人脸跟踪和跨素材同人识别尚未接入。

## 1. 当前可用能力

完整分析已经产生并保存：

- Shot 的真实 `startSec / endSec`。
- Shot 覆盖的字幕分段 `startSec / endSec / text`。
- 镜头描述、镜头类型、运镜、音频摘要和叙事用途标签。
- 分析产物到数据库 `shots` 的可追溯同步。

这些数据足以让剪辑 Planner 按“某个真实时间范围说了什么、发生了什么”选片，但字幕边界仍是 ASR segment 估计值。

## 2. 词级时间戳 Spike

本机 `whisper-server --help` 显示：

- `--dtw MODEL` 可以在启动时计算 token 级时间戳。
- `--split-on-word` 可以按词切分。
- `--word-thold` 可以设置词时间戳概率阈值。

当前链路没有启用：

1. `ai-model-daemon/pkg/runtime/whisper.go` 启动 `whisper-server` 时只传 host、port、model 和 threads。
2. ClipIQ 只读取 `verbose_json.segments` 的 `start / end / text`。
3. 当前模型 manifest 没有 DTW 对齐模型或模型专属 DTW 配置。
4. faster-whisper sidecar 当前响应只返回全文、语言和时长，连 segment 都没有透传。

结论：

- 当前 `transcriptGranularity` 必须标记为 `segment`。
- 接入词级时间戳需要先改 daemon 的运行时参数、响应契约和模型清单，再由 ClipIQ 原样保存 `words`。
- 词级时间戳属于音频对齐结果，不能由 LLM 根据字幕文本猜时间。

## 3. 说话人分离 Spike

`whisper.cpp --diarize` 是双声道声道级区分，不是任意单声道多人场景的通用 diarization。`--tinydiarize` 需要专用模型，当前 daemon manifest 没有提供。

因此：

- 当前字幕不能可靠附带 `speakerId`。
- 后续应接独立 diarization 后端，输出 `speaker_tracks`。
- `speakerId` 只表示一条视频内的音频说话人，默认不等于画面中的人物。
- 画外音、多人同框、音画错位必须允许保持未关联。

## 4. 人物身份数据地基

新增本地数据层：

- `people`：素材库级人物实体，可匿名或由用户命名。
- `person_appearances`：单素材内轨迹，保存视频、Shot、时间范围、检测置信度和可选人物归属。
- `speaker_tracks`：独立音频说话人轨迹。
- `person_identity_events`：命名、合并、拆分、说话人关联等人工决策审计记录。
- `person_identity_constraints`：保存人工确认的“不是同一人物”约束，供后续聚类排除候选。

人脸 embedding 只保存在本地数据库内部，不经 renderer IPC 返回。Renderer 只能读取人物和时间证据，避免无意暴露可复用的生物特征向量。

## 5. 跨素材同人匹配策略

自动匹配必须同时满足：

- 人脸样本质量达到模型标定阈值。
- 与最佳人物原型的相似度达到模型标定阈值。
- 最佳与次佳候选之间有足够 margin。
- 没有命中人工“不同人物”约束。

任一条件不满足时保持未知。阈值不能写成跨模型通用常量，必须基于选定 embedding 模型和固定素材集标定。

人工决策优先级：

1. 用户拆分或重新指派的出镜记录设为 `manualLocked`。
2. 重新分析同一素材时保留这些记录，不被自动聚类覆盖。
3. 人物合并后，相关出镜和说话人记录迁移到目标人物；来源人物保留为 `merged`，便于审计。

## 6. 后续实现顺序

1. 在 `ai-model-daemon` 增加可选词级时间戳并完整透传 segment/word。
2. 选定跨平台人脸检测、跟踪和 embedding sidecar，先做离线固定集评测。
3. 接入单素材轨迹，只产 `trackId`，不急于跨素材合并。
4. 标定跨素材相似度和 margin；固定测试集错误自动合并必须为 0。
5. 接独立 diarization，并在有足够视听证据时建立 speaker-person 关联。
6. 把人物、对白、事件和时间范围作为 Candidate Builder 的可过滤证据。
