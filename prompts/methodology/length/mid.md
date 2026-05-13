# 中视频时长规则（1-3 分钟）

适用：抖音长视频、视频号、小红书横版、B 站短中视频。是短视频与长视频之间的过渡区，钩子仍需快但允许多一层铺垫。

---

## 规则

### R-MID-001 双钩子结构
- category: hook
- when: 0-3s 主钩 + 15-20s 第二钩
- hit: 0-3s 有主钩子，15-20s 出现内容升级 / 反转 / 新信息触发再钩
- violation: 钩完一次后节奏迅速松懈
- miss: 全片只钩一次
- fix: 在 15-20s 位置补一个"接钩"信号（视觉跳切 + 字幕高亮）

### R-MID-002 三段时间分配
- category: structure
- when: 整片（按 90s 视频估算）
- hit: 大致符合 钩 5s → 铺垫 / 痛点 20s → 主体 / 解决 50s → 收尾 / CTA 15s
- violation: 主体段 < 30s（说不清）或铺垫段 > 30s（拖沓）
- fix: 调整段落时长比例，主体段最长

### R-MID-003 镜头平均时长
- category: pacing
- when: 整片
- hit: 平均镜头 2-3s，含 1-2 个 4s+ 长镜头作为情绪锚点
- violation: 平均 < 1.5s（眼花）或 > 4s（拖）
- fix: 重新调整切点

### R-MID-004 中段防流失
- category: engagement
- when: 30-50s 之间
- hit: 此区间至少有一次 pattern interrupt（角度变 / 字幕飞入 / 音效切换）
- violation: 此区间画面与节奏长时间稳态
- fix: 加视觉刺激点

### R-MID-005 钩子兑现节点明确
- category: structure
- when: 主体段
- hit: 能清晰指出"承诺的 X 在第 Y 秒兑现"
- violation: 看完不知道承诺有没有兑现
- fix: 在兑现点加显式视觉强调（字幕放大 / 暂停定格）
