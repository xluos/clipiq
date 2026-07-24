# 人物时序与跨素材身份分析设计

## 目标

人物分析为 AI 剪辑提供可追溯证据，而不是给素材贴一个模糊的人名标签。每条人物证据必须能回到：

- `videoId / shotId / startSec / endSec`
- 同一素材内的匿名 `trackId`
- 可选的素材库级 `personId`
- 检测、轨迹和身份匹配各自的置信度
- 代表帧、模型 ID 和人工修订状态

`trackId` 表示“这个视频里连续出现的同一张脸”；`personId` 表示“素材库中经足够证据确认的同一个人”。二者不能混用。

## 当前能力边界

已具备：

- `people / person_appearances / speaker_tracks` 数据层和 IPC。
- 保守的跨素材人物原型匹配器。
- Planner 对低置信度人物身份的过滤。
- Provider 契约、模型许可门禁和确定性单素材轨迹构建器。
- 人物分析编排器；Provider 未就绪或返回越界结果时不覆盖旧证据。
- YuNet 2023 + ONNX Runtime Node 本地检测，输出人脸框、5 个关键点和质量分。
- SFace 2021dec + 五点对齐的 128 维本地身份向量。
- 按真实 Shot 生成 1 秒证据窗口，长素材最多 900 帧并记录降采样。
- 同一 Shot 内按空间连续性生成轨迹，跨 Shot 只靠同模型向量延续。
- 高质量轨迹按模型、阈值和候选间隔保守复用素材库 `personId`；新身份创建稳定自动实体。
- 自动人物、出镜区间、向量模型和向量质量在同一事务中落库。
- Sherpa-ONNX 离线说话人分离，按视频生成匿名 `speakerId` 和精确说话区间。
- 字幕段与词级时间证据按重叠、覆盖率、主导度和候选差距门槛标注 `speakerId`。
- 素材库人物管理支持命名、合并、按出镜区间拆分和人工说话人关联；人工结果在重分析时锁定保留。
- Candidate Builder 支持人物、说话人、事件、对白和素材内时间范围过滤，过滤人物时只消费可信身份。
- 人物轨迹按 Shot 保存归一化联合人脸框，Candidate 与 `EditPlan` 透传该焦点证据。
- 横竖屏比例不一致时，只有人物焦点能完整进入目标窗口才生成裁切；多人跨度过大、焦点缺失或尺寸异常时保留等比缩放留边。

尚未具备：

- 覆盖换衣、侧脸、相似人物、遮挡和多人交叉的正式大样本阈值标定。
- 跨素材声纹身份复用。
- 自动 `speakerId -> personId` 视听关联和口型活动检测。
- 人体/物体等非人脸主体跟踪，以及随时间平滑移动的动态裁切关键帧。

因此当前生产分析能回答“这个时间范围有哪些人物轨迹、谁在说话、对应哪些字幕”，并能在清晰正脸证据充足时跨素材复用同一个自动 `personId`。这些时间证据会进入 AI 候选和 `EditPlan`，人物焦点还可驱动保守的横竖屏重构图。`personId` 只是本地人物簇，不代表已经知道现实身份或姓名；没有可靠向量时仍只保留匿名轨迹。说话人数量在未知人数模式下是保守估计，不宣称等于现场真实人数。

## 分层管线

```text
真实 Shot 时间轴
  -> 按 Shot 抽取低频分析帧
  -> FaceAnalysisProvider 检测人脸、关键点和质量
  -> FaceTracker 在单视频内生成 trackId
  -> 每个 Shot 拆分 PersonAppearance 精确区间
  -> 可用且获授权的 embedding 模型生成轨迹原型
  -> PersonClusterer 保守匹配素材库 personId
  -> 人工命名、合并、拆分作为最高优先级约束
  -> Candidate Builder / Planner 只消费可信身份
```

### Provider 契约

Provider 必须显式声明：

- 检测、关键点、向量能力。
- 每个模型的 ID、版本、角色和许可状态。
- 生产可用、禁止生产或需要用户确认。
- 未就绪原因；运行时、模型文件或硬件缺失时必须显式降级。

模型“可以下载和运行”不等于“允许随产品用于生产”。生产管线会拒绝研究用途模型。

### 单素材轨迹

轨迹关联采用以下保守规则：

- 同一 Shot 内可使用框重叠和中心位移保持短时连续。
- 跨 Shot 只接受同一 embedding 模型且达到标定阈值的关联。
- 两个检测不能在同一帧关联到同一轨迹。
- 超过最大时间间隔、新旧向量模型不同、相似度不足时新建匿名轨迹。
- 多人交叉、遮挡、背影或低质量脸允许拆轨，不以错误合并换召回率。

轨迹跨 Shot 延续时，落库仍按 Shot 拆成多个 `PersonAppearance`，但共享同一个 `trackId`。

每个 `PersonAppearance.focusBounds` 保存该 Shot 区间内全部有效人脸框的归一化联合范围。它是可追溯的构图证据，不是身份判断依据。编译竖屏或横屏 `EditPlan` 时：

- 先收集片段时间内全部人物焦点，避免只照顾一个人而裁掉同框者。
- 在联合范围两侧保留安全边距，且要求整个焦点范围能装入目标比例裁切窗口。
- 生成偶数像素的 `crop`，与 FFmpeg `yuv420p` 代理路径兼容。
- 任何证据不足或无法完整容纳的情况都不写 `crop`，沿用现有等比缩放和黑边，不伪造主体位置。

### 跨素材身份

跨素材匹配只比较同一模型、同一维度、质量达标的轨迹原型。自动写入 `personId` 还需要：

- 相似度超过该模型在固定测试集上的阈值。
- 第一候选与第二候选有足够差距。
- 不违反人工拆分约束。
- 已合并人物和过期模型原型不参与候选。

高质量向量无法可靠匹配已有人物时创建新的自动 `personId`，而不是强行并入已有人物；低质量或无向量轨迹保持 `personId` 为空。人工确认的人物关系优先于后续自动重分析。

## 模型路线

### 检测

当前检测后端采用 [OpenCV Zoo 的 YuNet 2023](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md)。其目录明确采用 MIT License；它只负责人脸框和关键点，不负责跨素材身份。

- Electron main 通过 [ONNX Runtime Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) 做本地 CPU 推理。
- 模型由 `ai-model-daemon` 按需下载和校验，不在 ClipIQ 中重复维护模型目录。
- 固定 640 输入采用保持宽高比的 letterbox，后处理对齐 OpenCV `FaceDetectorYN` 的解码规则。
- macOS arm64 已用 OpenCV Lena 样本完成真实推理与三帧连续轨迹落库；Intel Mac 和 Windows 仍需打包验收。
- 本机三帧热运行约 240 ms；实际素材性能以抽帧开销和帧数为主，长素材通过 900 帧上限降级。

### 身份向量

当前默认身份向量后端采用 [OpenCV Zoo SFace 2021dec](https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/README.md)。该模型目录随模型文件声明 Apache-2.0：

- YuNet 的 5 个关键点按 OpenCV `FaceRecognizerSF` 模板做相似变换，对齐到 `112 × 112`。
- ONNX 输入为 RGB NCHW、`0..255` 浮点值，输出 128 维后做 L2 归一化。
- 只有 `embeddingQuality >= 0.5` 的清晰人脸生成身份向量。
- 跨素材自动复用要求余弦相似度 `>= 0.5`，且比第二候选至少高 `0.08`。
- 当前视频的旧证据不进入跨视频候选原型，避免用自身历史结果证明自身。
- 不同向量模型、维度异常、人工拆分排除或已合并人物都不能成为自动匹配候选。

不能直接把官方 InsightFace 预训练识别权重作为 ClipIQ 生产默认模型：[InsightFace 官方许可说明](https://github.com/deepinsight/insightface#license)明确区分 MIT 代码和仅限非商业研究的训练数据/预训练模型，Buffalo 等识别模型需另行联系授权。

OpenCV 的 SFace LFW 示例阈值是 `0.363`，但本地 18 条真实素材中该值发生了 1 个不同人物误合并，因此不能直接照搬。当前 `0.5` 由同一主人物 8 条、不同人物 10 条的 bootstrap 标定：同人物 pair 召回 `75%`、错误合并 `0`、精确率 `100%`。证据与复现命令见 [`person-identity-sface-validation.md`](./person-identity-sface-validation.md)。这仍不是正式大样本人脸评测集；侧脸低头会被保守拆开，继续优先避免错误合并。

### 说话人分离

当前采用 Sherpa-ONNX WASM 的离线管线：

- Pyannote segmentation 3.0 INT8 做语音活动和说话区间分段，模型许可为 MIT。
- 3D-Speaker ERes2Net 16 kHz 模型生成片段声纹，模型与项目许可为 Apache-2.0。
- Sherpa-ONNX 运行时许可为 Apache-2.0；同步 WASM 推理放在 Worker Thread 中，避免阻塞 Electron main。
- daemon 按需下载两类模型；模型或运行时不可用时保留旧 `speaker_tracks`，不阻断字幕和画面分析。
- 未知人数模式使用 `threshold = 0.8`、`minDurationOn = 0.3s` 的保守聚类。它优先避免不同人误并，可能把同一人拆成多个匿名 `speakerId`。
- 如果未来从用户或场景得到可靠人数，可用固定 `numClusters` 重聚类；不能从画面人数直接猜音频人数。

真实四人样本、模型哈希、运行时间和人数未知模式的边界见 [`speaker-diarization-validation.md`](./speaker-diarization-validation.md)。

## 与字幕和说话人的关系

字幕时间、说话人轨迹和出镜人物是三类独立证据：

- Whisper 字幕提供 segment 或通过覆盖率门槛的 word 时间。
- 说话人分离提供视频内匿名 `speakerId` 和多个 `startSec / endSec` 区间。
- 人脸轨迹提供匿名 `trackId` 和可选 `personId`。

字幕段只有在说话区间覆盖率、主导比例和第一/第二候选差距同时达标时才写段级 `speakerId`；词级时间存在时逐词独立判断。多人重叠或证据不足时保持为空。

只有嘴部活动、时间重叠和人工确认等证据充分时，才建立 `speakerId -> personId` 关联。当前尚未自动建立该关联。画外音、背影和多人同框不能靠“画面里正好有谁”强行归属。

## 验收数据集与指标

固定测试素材至少覆盖：

- 同一人物跨三个视频、换衣、侧脸和不同光照。
- 两名外观相近人物的负样本。
- 多人同框、交叉走位、短时遮挡、背影和快速切镜。
- 画外音、多人轮流说话和人物未出镜。

核心指标：

- 错误自动合并数必须为 `0`。
- 单视频轨迹误切换率单独记录。
- 跨素材同人物召回率单独记录，不以降低错误合并为代价。
- 每条出镜证据的时间、Shot、代表帧和模型版本可追溯。
- 研究用途或未确认许可的模型无法进入生产分析。
- 阈值或模型版本变化时必须重跑固定正负样本，不沿用旧模型结论。
