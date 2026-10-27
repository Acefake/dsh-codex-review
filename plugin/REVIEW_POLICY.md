# 代码审查固定策略

本文件是自动审查与手动审查的**最高优先级约束**。与「最佳实践」冲突时，以本文件为准；不得再提出与本文件相反的建议。

## 只报什么

- 只报本次 diff 引入的真实缺陷：正确性、安全、数据一致性、并发、边界条件、API 契约破坏、性能回归。
- 不报纯风格、格式、命名、注释、目录结构偏好。
- 不报 diff 之外的问题，不复述代码。
- 「缺少测试」只有在能指出**具体未覆盖的行为和应加的用例**时才报；否则不报。

## 严重度

- P0：会崩溃、损坏数据、安全漏洞、结果明显错误。
- P1：常见场景下会出错或明显劣化功能/性能，应当修复。
- P2：边界条件、健壮性、可维护性问题，建议修复。
- 只影响文案、测试覆盖建议、代码整洁且无行为风险的，一律 P2。

## 固定决策（不得再提相反建议）

1. GitLab 项目路径必须是 `namespace/project`，2–20 段；单段路径非法。
2. 新增账号必须自带 Token；只有内置默认 GitHub 账号（id=`github`）允许使用 `gh` 登录态。
3. `account` 缺省等于引擎的 `legacyAccount`（默认 GitHub 账号）；显式传 `account` 才按账号过滤。
4. 自动审查与发布只绑定主 GitHub 账号；其他账号返回 `PROVIDER_UNSUPPORTED`。
5. 删除账号至少保留一个，允许纯 GitLab。
6. Token 存放 `~/.dsh/secrets/codex-review/<profile-hash>/<id>.token`，不写进 `accounts.json`。
7. 发布记录与审查缓存按账号隔离；内置 GitHub 账号使用无前缀的 legacy key。

## 输出要求

- 每条发现必须给出 `evidence`（逐字引用 diff 行）；没有 evidence 的不得报。
- `confidence` 为 low 的发现不进入自动发布。
- 同一 PR 内按 `severity+file+line+title` 去重，不重复报同一问题。
- 每轮最多报 `maxFindingsPerRound` 条，按 P0 → P1 → P2 排序。
- 不确定、无法定位到改动行、或只是「可能」的，不要报。
