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
- 按真实 Shot 生成 1 秒证据窗口，长素材最多 900 帧并记录降采样。
- 同一 Shot 内按空间连续性生成匿名轨迹，并原子写入 `person_appearances`。

尚未具备：

- 经过授权并用固定测试集标定的人脸特征模型。
- 通用多人说话人分离。

因此当前生产分析已经能回答“这个时间范围画面里有几条匿名人物轨迹”，但不能宣称已经识别了具体人物；没有可靠向量时只保留匿名轨迹。

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

### 跨素材身份

跨素材匹配只比较同一模型、同一维度、质量达标的轨迹原型。自动写入 `personId` 还需要：

- 相似度超过该模型在固定测试集上的阈值。
- 第一候选与第二候选有足够差距。
- 不违反人工拆分约束。
- 已合并人物和过期模型原型不参与候选。

无法确定时保持 `personId` 为空。人工确认的人物关系优先于后续自动重分析。

## 模型路线

### 检测

当前检测后端采用 [OpenCV Zoo 的 YuNet 2023](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md)。其目录明确采用 MIT License；它只负责人脸框和关键点，不负责跨素材身份。

- Electron main 通过 [ONNX Runtime Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) 做本地 CPU 推理。
- 模型由 `ai-model-daemon` 按需下载和校验，不在 ClipIQ 中重复维护模型目录。
- 固定 640 输入采用保持宽高比的 letterbox，后处理对齐 OpenCV `FaceDetectorYN` 的解码规则。
- macOS arm64 已用 OpenCV Lena 样本完成真实推理与三帧连续轨迹落库；Intel Mac 和 Windows 仍需打包验收。
- 本机三帧热运行约 240 ms；实际素材性能以抽帧开销和帧数为主，长素材通过 900 帧上限降级。

### 身份向量

不能直接把官方 InsightFace 预训练识别权重作为 ClipIQ 生产默认模型：[InsightFace 官方许可说明](https://github.com/deepinsight/insightface#license)明确区分 MIT 代码和仅限非商业研究的训练数据/预训练模型，Buffalo 等识别模型需另行联系授权。生产接入必须选择以下之一：

1. 取得明确商业授权的模型。
2. 使用来源、训练数据和商业使用权都可审计的替代模型。
3. 支持用户自带模型，并在产品中显式确认其使用权。

阈值不能沿用网上经验值，必须按最终模型和固定测试素材重新标定。

## 与字幕和说话人的关系

字幕时间、说话人轨迹和出镜人物是三类独立证据：

- Whisper 字幕提供 segment 或通过覆盖率门槛的 word 时间。
- 说话人分离提供匿名 `speakerId`。
- 人脸轨迹提供匿名 `trackId` 和可选 `personId`。

只有嘴部活动、时间重叠和人工确认等证据充分时，才建立 `speakerId -> personId` 关联。画外音、背影和多人同框不能靠“画面里正好有谁”强行归属。

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
