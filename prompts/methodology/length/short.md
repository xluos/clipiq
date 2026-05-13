# 短视频时长规则（<60 秒）

适用：抖音 / TikTok / Reels / 视频号上 15s-60s 的竖屏短视频。

核心结构：`Hook(0-3s) → Value Drop(4-15s) → Story/Payoff(16-45s) → CTA`。算法奖励完播率，0-3s 决定生死。

---

## 规则

### R-SHORT-001 黄金 3 秒强制
- category: hook
- when: 0-3s
- hit: 高强度钩子（悬念 / 数据冲击 / 视觉异常 / 反常识陈述）
- violation: 0-3s 是品牌 logo、平淡空镜或冗长开场
- miss: 完全没有钩子
- fix: 重剪首 3 秒，直接抛出核心反转

### R-SHORT-002 7-8 秒第二钩
- category: engagement
- when: 7-8s 位置（平均流失点）
- hit: 在第 7-8s 有一次 beat-sync 转场 / 信息回扣 / 视觉重置（picks-up）
- violation: 7-8s 节奏松懈、出现冗长画面
- miss: 该位置无任何刺激
- fix: 在 7-8s 加入第二个小钩子（如再抛一个反问、画面跳切）

### R-SHORT-003 镜头平均时长上限
- category: pacing
- when: 整片
- hit: 平均镜头切换 1-2.5s
- violation: 平均镜头 > 3s 或单镜头 > 5s 无内容递进
- fix: 把无内容长镜头剪短或拆分

### R-SHORT-004 信息密度饱和
- category: density
- when: 整片
- hit: 每 5 秒至少 1 个新信息单元（数据 / 反转 / 视觉点）
- violation: 出现 > 8s 信息断档（既无新信息也无情绪推进）
- fix: 删除空白段或加入字幕 / 数据点

### R-SHORT-005 CTA 明确
- category: completion
- when: 最后 3-5s
- hit: 有明确行为引导（点赞 / 关注 / 评论 / 看下一期）
- violation: 结尾突兀 / 无 CTA / CTA 含糊
- fix: 加一句具体行为指令

### R-SHORT-006 避免开头冗长自我介绍
- category: hook
- when: 0-5s
- violation: "大家好我是 XXX，今天给大家分享..."这类铺垫
- fix: 删除自我介绍，把内容钩子前置；自我介绍放进字幕一闪而过
