# Vlog 真人固定素材集

更新时间：2026-07-24

## 目的

真人视频和人物真值保存在仓库外；仓库只维护 manifest 契约、探测命令和质量计算。这样既不提交个人素材，也能保证每次迭代使用同一套文件和标注口径。

示例 manifest：[`vlog-evaluation-dataset.example.json`](./vlog-evaluation-dataset.example.json)。

示例只展示结构，不附带视频，直接运行会正确报告文件缺失。建立固定集时，将示例复制到仓库外的素材目录并替换为真实相对路径。

## 校验命令

```bash
npm run vlog:validate-dataset -- /absolute/path/to/dataset/manifest.json
```

需要机器可读结果时：

```bash
npm run vlog:validate-dataset -- /absolute/path/to/dataset/manifest.json --json
```

命令通过项目内 `ffprobe-static` 读取真实文件，不修改素材，检查：

- 10～20 条素材、总时长 10～30 分钟。
- 所有路径均相对 manifest，不能越出数据集目录。
- 中文路径、带空格路径、横竖屏混合。
- 至少一个事件覆盖全景、人物、动作、细节、反应镜头。
- 模糊、抖动、重复、无声、强噪声等负样本。
- 多人同框、背影、遮挡、画外音和相似人物负例。
- 同一人物出现在至少 3 条素材，且覆盖换衣、侧脸和光照变化。
- 至少两个不同人物，用于统计错误自动合并。
- 人物标注时间范围不越过真实素材时长。

声明时长与 `ffprobe` 实测相差超过 1 秒会产生 warning；文件缺失、方向不一致或必需覆盖缺失会判定失败。
FFprobe 只能验证文件、时长、方向和音轨；模糊、遮挡、相似人物等内容标签仍是人工真值，校验器只保证这些标签在固定集中有明确覆盖。

## Manifest 字段

每条 `materials` 记录包含：

- `key`：固定素材键，用于把测试集映射到 ClipIQ 的 `videoId`。
- `file`：相对 manifest 的视频路径。
- `durationSec`、`orientation`：人工清单值，运行时由 `ffprobe` 复核。
- `eventKey`：同一真实事件的分组键。
- `shotRoles`：`wide / person / action / detail / reaction`。
- `traits`：负样本或身份挑战标签。
- `identities`：人物真值时间段，`personKey` 只在该固定集内使用；多人同框素材必须提供归一化 `focusBounds`。

人物条件使用：

- `outfit_change`
- `side_face`
- `lighting_change`

## 与质量评估器衔接

`buildIdentityGroundTruthFromDataset` 接收：

- 已校验的 manifest。
- 本轮分析生成的 `PersonAppearance[]`。
- `materialKey → videoId` 映射。

它按同素材时间重叠选择最匹配的检测轨迹；标注提供 `focusBounds` 时还必须命中对应空间区域，避免多人同框时选错人物。转换结果用于生成 `evaluateVlogQuality` 所需的 `IdentityGroundTruthItem[]`。没有检测到的人物标注仍会以 `missing:*` 项进入评估，用于真实计算跨素材召回；不会被静默丢弃。

输出同时列出：

- `unmappedMaterialKeys`：尚未导入或无法映射的素材。
- `unmatchedLabelIds`：没有任何人物轨迹命中的真值段。

只要存在未映射素材，调用方就不能把身份评估标成完成。

## 当前状态

契约、文件探测、覆盖校验和身份真值转换已经自动化。真实 10～20 条生活素材及经同意的人物标注仍需在仓库外建立；在此之前，跨素材人物召回率保持“未评估”。
