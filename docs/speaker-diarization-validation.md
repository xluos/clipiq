# 离线说话人分离最小验证记录

验证日期：2026-07-24

## 目的

验证 ClipIQ 的离线说话人链路满足以下工程闭环：

1. 16 kHz 单声道 WAV 能生成带精确起止时间的匿名说话人轨迹。
2. 字幕段和词级时间能在证据明确时标注 `speakerId`。
3. Worker Thread 内推理不会同步占用 Electron main。
4. 识别成功后能原子替换 `speaker_tracks`，且不删除人物出镜证据。
5. 模型缺失、异常或取消时不覆盖旧说话人证据。

本记录验证工程可用性，不替代 DER/JER 正式评测。

## 运行时与模型

| 组件 | 文件或版本 | SHA-256 | 许可 |
|---|---|---|---|
| Sherpa-ONNX WASM | `sherpa-onnx@1.13.4` | npm 锁文件固定版本 | Apache-2.0 |
| Pyannote segmentation 3.0 INT8 | `pyannote-segmentation-3.0.int8.onnx` | `d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d` | MIT |
| 3D-Speaker ERes2Net base 16 kHz | `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` | `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b` | Apache-2.0 |

两份 ONNX 文件通过 `ai-model-daemon download speaker-diarization` 实际下载，并能由 `path speaker-diarization` 按 `segmentation / embedding` 角色返回。

## 固定样本与结果

样本为 Sherpa-ONNX 官方四人 WAV：

- 时长：`56.86s`
- 格式：16 kHz、单声道 WAV
- 样本 SHA-256：`bedf...7010`（本地验证记录缩写，样本未提交仓库）

本机 Apple Silicon 上完整 Provider → Timeline → SQLite：

| 模式 | 参数 | 结果 | 耗时 |
|---|---|---:|---:|
| 已知人数 | `numClusters = 4` | 4 个 speaker、10 段 | 约 `29.3s` |
| 人数未知，库默认 | `threshold = 0.5` | 7 个 speaker、11 段 | 约 `28.6s` |
| 人数未知，生产保守值 | `threshold = 0.8, minDurationOn = 0.3` | 5 个 speaker、10 段 | 约 `28.1–30.4s` |
| 人数未知，样本拟合值 | `threshold = 0.9, minDurationOn = 0.3` | 4 个 speaker、10 段 | 约 `28.2s` |

生产默认没有采用只对该样本更漂亮的 `0.9`。未知素材中错误合并不同说话人的后果高于多拆一个匿名簇，因此默认使用更保守的 `0.8`，并把人数视为估计值。

实际 daemon 下载模型跑生产参数后：

- `status = completed`
- `speakerCount = 5`
- `trackCount = 10`
- SQLite 持久化 `10` 条轨迹
- 4 条人工构造字幕段都得到对应 `speakerId`
- 第一段两条词级时间都得到相同的词级 `speakerId`

## 字幕归属门槛

- 段级：说话区间覆盖字幕段至少 `35%`，主导 speaker 占全部重叠至少 `75%`，且第一与第二候选差至少 `25%`。
- 词级：覆盖至少 `50%`，主导至少 `70%`，候选差至少 `20%`。
- 多人重叠或证据不足时不写 `speakerId`。
- Sherpa 当前不返回逐段置信度；数据库中的 `0.5` 是明确的中性占位，不能用于自动关联人物。

## 出镜人物关联门槛

已增加 `speaker-person-linker` 保守关联器，但它不会把“同时出镜”当作“正在说话”：

- 人物身份必须是人工确认，或跨素材 `identityConfidence >= 0.8`。
- 必须由声明了 `speaking_activity` 能力及独立生产许可模型的 Provider 提供 `speakingConfidence >= 0.85`。
- 口型证据必须覆盖该说话区间至少 `50%`。
- 第一人物占所有候选口型加权分至少 `80%`，且与第二人物差至少 `0.2`。
- 多人竞争、覆盖不足、画外音或身份不可信时清除旧自动关联并保持未知。
- 人工关联和人工取消关联都以 `manualLocked` 保留，自动分析不得覆盖。

每段关联都会保存 `linked / no_speaking_evidence / untrusted_identity / insufficient_coverage / ambiguous_people / manual_preserved` 决策、覆盖率和置信度。质量报告也会区分“已完成说话人分离”和“已有可靠人物关联”。

当前 YuNet + SFace 只提供人脸检测、5 点关键点和身份向量，不具备独立口型活动模型，因此默认生产链路不会自动把匿名说话人绑定到出镜人物。接入口型活动或视听同步模型并完成真人固定集标定前，这项能力明确保持降级，而不是用嘴部几何或同屏关系猜测。

## 当前边界

- `speakerId` 只在单视频内稳定，不做跨素材声纹身份复用。
- 自动关联器已接入分析管线，但当前默认人物 Provider 没有口型活动能力；实际关联仍依赖未来的独立模型证据或人工确认。
- 未知人数聚类可能过分段；正式上线质量验收需要中文 Vlog、多噪声、画外音和多人重叠固定集，并记录 DER/JER。
- Windows 与 Intel Mac 打包后的 WASM Worker 仍需发布前实测。
