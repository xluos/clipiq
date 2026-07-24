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

## 当前边界

- `speakerId` 只在单视频内稳定，不做跨素材声纹身份复用。
- 不自动把说话人关联到同屏人物；仍需口型活动、视听同步或人工确认。
- 未知人数聚类可能过分段；正式上线质量验收需要中文 Vlog、多噪声、画外音和多人重叠固定集，并记录 DER/JER。
- Windows 与 Intel Mac 打包后的 WASM Worker 仍需发布前实测。
