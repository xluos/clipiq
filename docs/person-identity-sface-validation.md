# SFace 跨素材身份最小验证记录

验证日期：2026-07-24

## 目的

验证 ClipIQ 当前 YuNet + SFace 实现满足最小闭环：

1. 同一人物经过亮度、尺寸和 JPEG 变化后仍复用同一个 `personId`。
2. 不同人物不自动合并。
3. 模型通过 `ai-model-daemon` 下载后能在 Electron 使用的 ONNX Runtime Node 上运行。
4. 自动人物、身份置信度和出镜区间能事务化写入 SQLite。

本记录包含工程最小样本和首个真人 bootstrap，仍不替代正式大样本人脸识别评测集。

## 模型

| 模型 | 文件 | SHA-256 | 作用 |
|---|---|---|---|
| YuNet 2023mar | `face_detection_yunet_2023mar.onnx` | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | 人脸框、5 点关键点 |
| SFace 2021dec | `face_recognition_sface_2021dec.onnx` | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | 128 维身份向量 |

SFace 下载后大小为 `38,696,353` bytes，daemon 能力标记为 `face_embedding`，只向 `clipiq` 暴露。

## 工程最小样本

- 正样本 A：OpenCV `lena.jpg`。
- 正样本 B：A 经亮度 `+0.08`、对比度 `1.08`、饱和度 `0.9`、缩放和重新编码得到的变体。
- 负样本：OpenCV `messi5.jpg` 中人脸区域裁剪并放大到 `512 × 512`，确保不是因面积质量门槛被直接跳过。

样本只用于本机验证，没有提交到仓库。

## 结果

| 比较 | 余弦相似度 | 自动复用阈值 | 结果 |
|---|---:|---:|---|
| Lena ↔ Lena 变体 | `0.958076` | 同一人物 |
| Lena ↔ Messi | `0.130133` | 不合并 |
| Lena 变体 ↔ Messi | `0.110487` | 不合并 |

三段素材依次跑完整 Provider → Tracker → Assignment → Repository 后：

- `video-a` 创建自动人物 A。
- `video-b` 命中人物 A，身份置信度 `0.958076`。
- `video-c` 创建独立人物 B。
- 最终为 2 个 `people`、3 条 `person_appearances`；人物 A 覆盖 2 个视频，人物 B 覆盖 1 个视频。
- 不同人物错误自动合并数为 `0`。

这个样本只能证明链路可运行。旧阈值 `0.82` 由这一组过于容易的正负例得到，在真人跨视频素材中会把同一人全部拆开，不能继续作为生产阈值。

## 真人 bootstrap

仓库外固定集：

- manifest：`~/Library/Application Support/clipiq/evaluation-datasets/人物 身份 bootstrap v1/manifest.json`
- 18 条真实竖屏素材，共 25.2 分钟
- 同一主人物 8 条，覆盖换衣、眼镜、侧脸低头和不同光照
- 10 个不同人物负例
- 每条素材只在人工确认的窄时间窗取中间帧，不用整条视频标签替代真值

评测走与生产相同的 YuNet → SFace → Tracker → Assignment → SQLite 链路，但使用内存数据库，结束后删除临时帧和向量，不修改 ClipIQ 业务数据：

```bash
npm run vlog:evaluate-identity-dataset -- \
  "$HOME/Library/Application Support/clipiq/evaluation-datasets/人物 身份 bootstrap v1/manifest.json"
```

阈值对比：

| 余弦阈值 | 同人物 pair | 召回率 | 错误合并 | 精确率 | 结论 |
|---:|---:|---:|---:|---:|---|
| `0.82` | `0 / 28` | `0%` | `0` | 未评估 | 过严，跨素材身份完全失效 |
| `0.363` | `21 / 28` | `75%` | `1` | `95.5%` | OpenCV LFW 示例值，当前固定集不可接受 |
| `0.5` | `21 / 28` | `75%` | `0` | `100%` | 当前生产值 |

`0.5` 下 7 条正脸/眼镜/换衣/光照变化素材复用同一 `personId`；侧脸低头素材保持独立人物簇。10 个不同人物没有自动误合并。

## 当前策略

- `embeddingQuality >= 0.5`
- `autoMergeThreshold = 0.5`
- `minimumMargin = 0.08`
- 只比较同一 embedding 模型。
- 达不到复用条件时创建新自动人物；无向量或低质量时保持匿名。
- 人工命名、拆分和合并锁定优先。

## 仍未覆盖

- 更大规模的侧脸、遮挡、强妆容、年龄变化和跨设备拍摄。
- 双胞胎或经过专门筛选的高相似人物。
- 多人交叉走位后的 track identity switch。
- Intel Mac 和 Windows 打包运行。

继续扩大召回率前，必须增加这些样本，并继续把错误自动合并数保持为 `0`。
