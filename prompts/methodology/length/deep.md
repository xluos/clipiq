# 深度长视频时长规则（10 分钟以上）

适用：深度测评、视频论文（video essay）、知识专题、纪录片、长教程。算法 + 用户行为都要求章节化、可跳读、强情绪曲线。

---

## 规则

### R-DEEP-001 章节标记必需
- category: structure
- when: 整片
- hit: 视频有可视化章节卡 / 章节标题，且与简介/平台章节标记对应
- violation: 全程无章节切换信号
- miss: 章节存在但未用视觉标记，观众无法跳读
- fix: 加入章节卡过场（黑场 + 标题 / 全屏文字 / 空镜配标题）

### R-DEEP-002 每 3-4 分钟一次视觉更新
- category: engagement
- when: 整片
- hit: 每 3-4 分钟引入新视觉元素（新场景 / 新视角 / 新道具 / 新画面构成）
- violation: 全片同一机位 / 同一场景超过 5 分钟
- fix: 用 b-roll、空镜、图表、动画分散同质画面

### R-DEEP-003 三幕情绪曲线
- category: structure
- when: 整片
- hit: 能识别出明确的 Setup → Confrontation → Resolution 三幕，且每幕有情绪锚点
- violation: 三幕模糊或缺少冲突 / 转折
- fix: 在中段制造冲突 / 反转，在结尾制造观点 climax

### R-DEEP-004 信息曲线让位于情绪曲线
- category: structure
- when: 视频论文 / 纪录片类
- hit: 节奏由情绪曲线主导而非信息密度（允许信息暂停以铺情绪）
- violation: 全程信息密度峰值，无情绪起伏
- fix: 在关键论点前 / 后插入情绪空镜 / BGM 抒情段

### R-DEEP-005 动静镜头搭配
- category: pacing
- when: 整片
- hit: 长镜头（5s+）与短切（<2s）交替出现，形成节奏对比
- violation: 长时间单一节奏（连续短切或连续长镜头）
- fix: 在快切段插入 1-2 个长镜头作为情绪锚

### R-DEEP-006 多次能量回升
- category: engagement
- when: 整片
- hit: 整片有 2-3 个明显能量高点（如 5min / 12min / 20min），不是一次性高潮
- violation: 只有一个高潮且位置过早或过晚
- fix: 把素材中的爆点 / 金句 / 反转分散到多个时间点

### R-DEEP-007 可跳读设计
- category: engagement
- when: 整片
- hit: 任意章节单独看都能理解（章首有 recap、章尾有总结）
- violation: 章节强依赖前文上下文，跳读不可读
- fix: 章首加上一句话 recap、章尾加上一句话总结

### R-DEEP-008 结尾升华 + 钩下一期
- category: completion
- when: 最后 2-3 分钟
- hit: 观点升华 + 主创视角 + 下一期钩子
- violation: 结尾仅 CTA 无升华，或拖沓没完没了
- fix: 用主创金句收束 + 一句话预告下期
