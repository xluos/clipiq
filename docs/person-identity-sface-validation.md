# SFace 跨素材身份最小验证记录

验证日期：2026-07-24

## 目的

验证 ClipIQ 当前 YuNet + SFace 实现满足最小闭环：

1. 同一人物经过亮度、尺寸和 JPEG 变化后仍复用同一个 `personId`。
2. 不同人物不自动合并。
3. 模型通过 `ai-model-daemon` 下载后能在 Electron 使用的 ONNX Runtime Node 上运行。
4. 自动人物、身份置信度和出镜区间能事务化写入 SQLite。

本记录是工程最小验收，不替代正式人脸识别评测集。

## 模型

| 模型 | 文件 | SHA-256 | 作用 |
|---|---|---|---|
| YuNet 2023mar | `face_detection_yunet_2023mar.onnx` | 由 daemon 清单和下载器校验 | 人脸框、5 点关键点 |
| SFace 2021dec | `face_recognition_sface_2021dec.onnx` | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | 128 维身份向量 |

SFace 下载后大小为 `38,696,353` bytes，daemon 能力标记为 `face_embedding`，只向 `clipiq` 暴露。

## 固定样本

- 正样本 A：OpenCV `lena.jpg`。
- 正样本 B：A 经亮度 `+0.08`、对比度 `1.08`、饱和度 `0.9`、缩放和重新编码得到的变体。
- 负样本：OpenCV `messi5.jpg` 中人脸区域裁剪并放大到 `512 × 512`，确保不是因面积质量门槛被直接跳过。

样本只用于本机验证，没有提交到仓库。

## 结果

| 比较 | 余弦相似度 | 自动复用阈值 | 结果 |
|---|---:|---:|---|
| Lena ↔ Lena 变体 | `0.958076` | `0.82` | 同一人物 |
| Lena ↔ Messi | `0.130133` | `0.82` | 不合并 |
| Lena 变体 ↔ Messi | `0.110487` | `0.82` | 不合并 |

三段素材依次跑完整 Provider → Tracker → Assignment → Repository 后：

- `video-a` 创建自动人物 A。
- `video-b` 命中人物 A，身份置信度 `0.958076`。
- `video-c` 创建独立人物 B。
- 最终为 2 个 `people`、3 条 `person_appearances`；人物 A 覆盖 2 个视频，人物 B 覆盖 1 个视频。
- 不同人物错误自动合并数为 `0`。

## 当前策略

- `embeddingQuality >= 0.5`
- `autoMergeThreshold = 0.82`
- `minimumMargin = 0.08`
- 只比较同一 embedding 模型。
- 达不到复用条件时创建新自动人物；无向量或低质量时保持匿名。
- 人工命名、拆分和合并锁定优先。

## 未覆盖

- 同一人物的侧脸、遮挡、强妆容、年龄变化和跨设备拍摄。
- 多名外观非常接近的人物。
- 多人交叉走位后的 track identity switch。
- Intel Mac 和 Windows 打包运行。

正式扩大默认召回率前，需要用这些样本补齐固定集，并继续把错误自动合并数保持为 `0`。
