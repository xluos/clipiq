# Vlog 多版本粗剪对比验证

## 目标

同一批真实候选和分析证据生成三个有明确取舍的粗剪版本：

- 叙事均衡：兼顾事件完整、节奏变化和情绪收束。
- 节奏优先：更快推进，强化动作变化和信息密度。
- 人物优先：强化可信人物连续性、真实反应和情绪锚点。

三个版本仍受同一组事实约束：只能引用候选 `candidateId`，不能修改素材时间范围，不能虚构人物、字幕或事件。

## 生成契约

`generateEditPlan({ variantCount: 3 })`：

1. 只构建一次候选集和分析证据质量报告。
2. 为每个固定方向独立调用 Planner。
3. 对 candidateId 播放顺序生成 SHA-256 签名。
4. 后续版本如果与已有版本完全相同，携带已有顺序重试一次。
5. 第二次仍重复时整组失败，不保存“换文案但镜头相同”的伪对比。
6. 三份 `EditPlan` 全部编译、校验通过后，在一个数据库事务内保存。

每份计划在 `provenance.variant` 保存：

- `groupId`
- `key / label / description`
- `index / count`
- 初始 `selectionSignature`

结构化反馈生成的新 revision 继承所属版本信息。签名表示该分支最初的 Planner 选择，不因用户后续调整而改写。

## Studio 行为

- “生成对比”创建三个方向。
- 对比卡显示方向、镜头数、素材数、实际时长和情绪变化。
- 当前版本使用 active 状态标记。
- 切换版本由主进程验证归属、校验状态和素材路径，再原子更新 `studio_sessions.currentEditPlanId`。
- 每个版本独立生成代理预览和后续 revision；切换不会覆盖其他分支。
- “重新生成”仍只生成单版，避免默认增加三倍 Planner 调用。

## 自动验证

```bash
npm test -- --run \
  test/vlog-variants.test.ts \
  test/vlog-candidate-planner.test.ts \
  test/edit-plan.test.ts \
  test/contract.test.ts \
  electron/preload.smoke.test.js
```

覆盖：

- 三个固定方向和数量边界。
- candidateId 顺序签名稳定性。
- 重复版本携带已有序列重试。
- 连续重复时明确失败。
- Planner prompt 的方向与避重约束。
- `EditPlan` 版本元数据持久化和校验。
- preload、main handler 与 TypeScript API 契约一致。

## 降级

- 素材候选不足以形成不同版本时明确报错，不随机打乱镜头。
- 任一版本 Planner 输出非法或编译校验失败时，不保存半组结果。
- 浏览器预览只验证 UI；真实生成依赖 Electron 中已配置的 `complex_text` Provider。
