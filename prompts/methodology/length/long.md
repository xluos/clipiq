# 中长视频时长规则（3-10 分钟）

适用：B 站主流时长、YouTube 中视频、视频号干货向中视频。算法以"播放分钟数"取代播放量，留存曲线呈三段呼吸。

---

## 标杆结构（10 分钟视频）

```
00:00 - 00:30   Hook + 价值承诺
00:30 - 02:00   问题 / 背景设定
02:00 - 05:00   核心内容 Part 1（信息密度最高）
05:00 - 06:00   节奏切换点（缓冲段，故事 / 幽默 / 转场）
06:00 - 10:00   核心内容 Part 2（深入 / 对比 / 实操）
10:00 - 11:00   总结 + 观点升华
11:00 - 12:00   互动引导 + 预告
```

留存曲线三段呼吸：`stimulate(0-3min) → calm(3-7min) → re-engage(8min+)`。

---

## 规则

### R-LONG-001 前 30 秒价值承诺
- category: hook
- when: 0-30s
- hit: 30 秒内明确告诉观众"这期能学到 X / 解决 Y / 看到 Z"
- violation: 30 秒还在闲聊或铺垫
- miss: 全程未明示价值承诺
- fix: 把核心论点 / 答案预告 / 章节列表压到前 30 秒

### R-LONG-002 三段呼吸节奏
- category: pacing
- when: 整片
- hit: 前 3 分钟密集 cut（10-20s 一次视觉重置）；3-7 分钟拉到 25-40s 间距；8 分钟后 calm + 短脉冲交替
- violation: 全程一致节奏（要么一直快剪累、要么一直慢镜头拖）
- fix: 按三段呼吸重新规划切点密度

### R-LONG-003 Pattern Interrupt 每 60-90s
- category: engagement
- when: 整片
- hit: 每 60-90s 至少一次刻意刺激（镜头角度变 / 字幕弹出 / 音效切入 / 数据 popup / 语速变化）
- violation: 出现 > 120s 视觉无变化区间
- miss: 整片几乎无 pattern interrupt
- fix: 在每 60-90s 节点加一种打断信号

### R-LONG-004 中段缓冲段
- category: structure
- when: 视频中段（约整片 50% 位置）
- hit: 出现明显的节奏切换 / 故事插入 / 幽默缓冲（30s-60s）
- violation: 高密度信息从头压到尾，无喘息
- miss: 完全没有缓冲段
- fix: 在中段插入故事 / 幕间 / 跟拍 b-roll 一段

### R-LONG-005 章节化
- category: structure
- when: 整片
- hit: 视频被自然分为 2-4 个章节，每章 2-4 分钟，有视觉标题 / 章节卡
- violation: 全程一条线，无章节感
- fix: 加章节卡 / 字幕标题，或重排素材形成章节

### R-LONG-006 第一段信息密度最高
- category: density
- when: 2-5 分钟区间
- hit: 此段是全片信息 / 干货 / 论点密度峰值
- violation: 此段反而是铺垫或案例
- fix: 把最核心论点提到这个区间

### R-LONG-007 8 分钟后能量回升
- category: engagement
- when: 8 分钟后（如片长 >= 9min）
- hit: 第 8 分钟之后有一次明显的视觉 / 情绪 / 信息能量回升
- violation: 8 分钟后节奏继续下滑直到结束
- miss: 长视频 8 分钟后毫无亮点
- fix: 把第二高潮 / 总结金句 / 数据爆点放在 8 分钟之后

### R-LONG-008 结尾观点升华
- category: completion
- when: 最后 1-2 分钟
- hit: 总结 + 观点升华 + 下集预告 / CTA 三件套
- violation: 结尾仅有"喜欢就点赞"，无内容升华
- fix: 补上一句金句或观点
