# subagents

Subagents 是 ZCode 自定义 agent profile 与运行时配置的唯一业务服务。Desktop、Host 和插件通过 `ISubagentsService` 调用；Renderer 不直接读写 profile 文件。

不变量：

- 用户 profile 根、项目 `.zcode/agents` 根和禁用状态只由 `SubagentsService` 管理；Cursor 文件和相邻仓库不参与发现。
- Profile 更新原子写入；改名由服务的持久化 journal 恢复，禁止覆盖冲突目标或丢弃用户编辑。
- 每个 Host 的 runtime cache 发布完整快照；文件观察器只让快照收敛，不拥有 profile 写入或身份。
- Workspace 身份使用 `workspaceIdentity?.trim() || workspacePath`；路径仍用于文件 IO。
- 插件 profile 是只读发现结果；模型覆盖与启用状态写入 ZCode 用户状态文件。

与其它模块的交界：调用方使用 `ISubagentsService` descriptor；共享 profile/schema 类型来自 `@zcode/shared`；文件系统和日志适配留在 `packages/services`。
