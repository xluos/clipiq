# 通用剪辑方法论

适用范围：所有视频类型与时长档位。LLM 在分析任何视频时都应加载此规则集作为基础。

每条规则会被 LLM 用来产出 `methodologyTags`（节点级，hit / violation）与 `methodologyAudit`（报告级，miss 也在这里）。所有打标必须给 `evidence`（引用具体节点/时间段）与 `confidence`（0-1）。

---

## 钩子（hook）

### R-HOOK-001 黄金 3 秒钩子
- category: hook
- when: 视频开头 0-3s
- hit: 出现明显悬念 / 痛点 / 反差 / 利益承诺 / 视觉冲击之一，让观众产生"想看下去"的认知缺口
- violation: 开头是冗长自我介绍、缓慢空镜配 BGM、模糊台词或品牌 logo 长动画
- miss: 0-3s 内没有任何钩子信号
- fix: 把视频中最具反转 / 数据冲击 / 痛点的片段直接前置到 0-3s

### R-HOOK-002 钩子三层同步
- category: hook
- when: 0-5s 内
- hit: 视觉钩子 + 文字 overlay + 旁白三层同时指向同一信息
- violation: 三者错位（如旁白讲 A、字幕讲 B、画面在拍 C）
- fix: 让首屏字幕、画面焦点、旁白第一句话围绕同一核心钩子

### R-HOOK-003 钩子类型可识别
- category: hook
- when: 开头钩子段
- hit: 可清晰归类到 6 类钩子之一（悬念式 / 视觉冲击 / 故事代入 / 知识分享 / 痛点共鸣 / 数据反差）
- violation: 钩子模糊，既不悬念、也不冲击、也无承诺
- fix: 从 6 类中选定一种刻意放大

---

## 结构（structure）

### R-STRUCT-001 起承转合完整
- category: structure
- when: 整个视频
- hit: 能清晰识别出开端 / 发展 / 转折 / 高潮 / 结尾五个阶段
- violation: 缺转折或缺高潮，节奏一条直线
- miss: 缺少明确的结尾（突然结束或观点没回收）
- fix: 在视频中后段补一个反转或对比，结尾收回观点 + CTA

### R-STRUCT-002 价值承诺兑现
- category: structure
- when: 钩子承诺 → 视频中后段
- hit: 钩子中承诺的"X 个方法 / 答案 / 反转"在视频里都兑现了
- violation: 标题党 / 钩子承诺与实际内容不符
- fix: 删除空承诺，或补回缺失内容

---

## 节奏（pacing）

### R-PACE-001 镜头长短交替
- category: pacing
- when: 整个视频
- hit: 镜头时长有节奏地长短交替（"两短一长"或"多短一长"）
- violation: 全程同一节奏（连续快剪或连续长镜头），无对比
- fix: 在快剪段中插入 1-2 个 3s+ 长镜头给观众喘息；慢节奏段中插入 2-3 个短切给信息密度

### R-PACE-002 节奏与情绪匹配
- category: pacing
- when: 情绪段
- hit: 抒情段用长镜头铺意境，冲突 / 爆点用短镜头快剪
- violation: 情绪与节奏错位（抒情段反而快剪、冲突段反而长镜头）
- fix: 重剪情绪段镜头时长

### R-PACE-003 转场克制
- category: pacing
- when: 整个视频
- hit: 转场样式 ≤ 3 种，且大部分是硬切 / 匹配剪辑
- violation: 转场种类 > 5 种或频繁炫技转场分散注意力
- fix: 删除花哨转场，保留 1-2 种主转场风格

---

## 声画（sound）

### R-SOUND-001 BGM 节拍同步
- category: sound
- when: 有 BGM 的段落
- hit: 剪辑点落在节拍上（beat sync），尤其是钩子结尾、章节切换
- violation: 剪辑点与节拍完全脱节，BGM 像背景噪音
- fix: 用音乐节拍标尺重新对齐主要切点

### R-SOUND-002 旁白节奏配合
- category: sound
- when: 有旁白的段落
- hit: 镜头切换跟随旁白语义停顿（一句话一切、或一句话内重音切）
- violation: 镜头切在旁白句子中间无意义位置
- fix: 把切点对齐到逗号 / 句号

---

## 信息密度（density）

### R-DENS-001 单一信息单元清晰
- category: density
- when: 每个镜头 / 节点
- hit: 每个镜头表达单一明确的信息（视觉主体 + 字幕 + 旁白指向同一点）
- violation: 单镜头堆叠多个信息（多字幕、多旁白要点、多视觉焦点）
- fix: 拆成多个镜头，每镜头只讲一件事

---

## 完播（completion）

### R-COMPLETE-001 结尾回收
- category: completion
- when: 视频结尾 5-10s
- hit: 有明确的总结句 / 情绪落点 / CTA / 钩子下一期之一
- violation: 突然结束、镜头突然黑屏、或结尾拖沓
- miss: 没有任何回收动作
- fix: 加一句总结 + CTA / 预告
