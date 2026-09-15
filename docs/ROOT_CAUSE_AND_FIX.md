# Dispatch 子话题回执误建 Coordinator 会话：根因与修复

## 结论

问题由两条独立但会串联的路径造成：

1. **入站路由把控制面回执当成新会话任务。**
   Worker 在 dispatch 子话题中发送普通 ack/progress/completion 时，卡片 footer
   或正文可能仍然 `@Coordinator`。Coordinator 在该子话题没有既有会话，
   `event-dispatcher` 因 bot-to-bot mention 进入 `handleThreadReply`，随后
   `handleThreadReplyAdmitted` 的 safety-net 看到该 anchor 无会话，执行普通
   auto-create。
2. **正式 report 在 Worker 回合结束后错误依赖 live turn。**
   `/api/report-relay` 已有三层可靠绑定：当前 source session、dispatch child
   root、宿主签名的 orchestrator target；但授权仍无条件要求
   `managedTurnOrigin.turnId`。Worker 终端完成后会主动撤销 live turn capability，
   因此非隔离、宿主 HMAC 已认证的 `botmux report --dispatch-root ...` 也会得到
   `turn_provenance_stale`。调用者随后若自行用 `--into` + `@Coordinator` 降级，
   又会触发第一条误建路径。

修复不按“收到”“完成”等文案猜测消息类型，而是基于持久 dispatch registry 和
HMAC report binding 做精确判定。

## 入站修复

新增 `src/core/dispatch-child-mention-policy.ts`，并在
`handleThreadReplyAdmitted` 的 quota、资源下载和 session auto-create 之前执行。

只有以下条件**全部满足**时，普通 bot mention 才作为 dispatch control-plane side
traffic 静默结束：

- 当前 scope 是 thread，anchor 是 registry 中存在的 dispatch root；
- report binding 的 HMAC 校验成功；
- binding 中的 Coordinator app 与当前 receiver app 完全一致；
- sender 精确匹配该 dispatch 的目标 Worker：
  - 优先支持持久 `targetAppIds` 与 Lark-stamped `union_id` 映射出的本机 app；
  - 同时支持 registry 中派单时记录的 receiver-scoped Worker open_id；
- registry 的 `targetChatId`（若存在）与当前 chat 一致；
- 当前 Coordinator 在该 child anchor 上没有既有 session；
- sender 是 bot；
- 消息不是显式 `@steer`，也不是 slash/daemon command。

任何 registry 损坏、binding 缺失/错误、身份不完整或歧义都会 **fail open**：
保留原 bot-to-bot 路由，而不是扩大静默范围。

因此以下语义保持不变：

- `@steer` 可以显式进入/创建 Coordinator 子话题控制会话；
- slash/daemon command 保持原控制路径；
- 人类 `@Coordinator` 正常创建或路由；
- 非 dispatch thread 的 bot-to-bot 协作保持；
- Coordinator 已有 child session 时，后续普通消息继续进入该 session；
- dispatch Worker 自己的 child session 不受影响；
- 正式 `botmux report` 不经过 Lark mention ingress，仍由 registry 唤醒原
  orchestrator session。

## Report stale-provenance 修复

`authorizeReportSessionRelayRequest` 现在区分两种授权状态：

1. **live turn 仍存在**：继续使用原来的 per-turn capability 和精确路由校验；
2. **live turn 已在 terminal 后撤销**：仅对 trusted-host HMAC 请求开放窄恢复路径。

terminal 后恢复仍要求：

- source session id 和 source daemon app 由 daemon 自己解析；
- dispatch report binding HMAC 有效；
- source session app 是 registry 中该 dispatch 的目标 Worker；
- thread-scope session 的持久 `rootMessageId` 等于 dispatch root；
- chat-scope session 还必须有精确 `dispatchInputReceipts`，证明某一已提交 Worker
  输入属于该 dispatch root。

非 trusted-host 的隔离请求仍要求 live capability，不因本修复扩大权限。

CLI 在仍遇到 `turn_provenance_stale` 时会明确提示：在当前 Worker 会话的新一轮重试
同一条正式 report，禁止用普通 send、`--into` 或 `@Coordinator` 降级。

## 回归覆盖

新增/扩展测试覆盖：

- dispatch child：Worker 普通 mention、`--into` 风格 completion mention，无
  Coordinator child session时不 auto-create，且不进入资源下载；
- 同场景 `@steer` 和 Worker slash command 保持控制路径；
- 人类 mention 正常创建；
- 非 dispatch bot-to-bot thread 正常创建；
- 已有 Coordinator child session 时普通后续消息继续投递；
- policy 对错误 binding、非目标 Worker、Worker 自身 receiver 均不抑制；
- 正式 report 继续构造并投递到原 orchestrator session；
- trusted-host report 在 turn terminal 清除 live provenance 后可恢复；
- chat-scope post-terminal report 只接受持久 dispatch input receipt；
- 非目标 Worker 的 post-terminal report 被拒绝；
- CLI stale 错误提示不再诱导 mention/`--into` fallback；
- host memory admission blocked/retry、dispatch registry/binding/lifecycle 相关测试保持。

验证命令与结果：

```text
npx -y bun@1.4.2 x vitest run --project unit <focused-and-affected-tests>
  8 files passed, 671 tests passed

npx vitest run --project unit test/daemon-rename-route.test.ts \
  -t 'dispatch child|non-dispatch bot collaboration'
  7 tests passed

npx -y bun@1.4.2 run build
  passed (tsc, script/test-mock typecheck, dashboard bundle, dist audits)

git diff --check
  passed
```

完整 unit suite 也已尝试；当前 worktree 按仓库约定复用 canonical `node_modules`，
但 canonical checkout 的依赖版本落后于最新 upstream lock（例如 React 与
react-test-renderer 小版本不一致），导致大量既有 UI test 出现 invalid-hook-call；
同时有并行资源超时。结果为 1287 files / 22620 tests passed，39 files / 468 tests
failed。失败集中在依赖漂移/资源环境，聚焦与受影响测试、typecheck 和 build 均通过。
依照仓库规定，没有在共享依赖 worktree 中运行 install。

## 影响面

- 改动位于 Lark thread ingress、dispatch registry/binding 和 report relay。
- 不改变 CLI adapter、PTY/Tmux backend、模型或平台无关 worker 执行逻辑。
- 新增 registry 读取只发生在“foreign bot + thread + 无 receiver session + 普通消息”
  的窄候选路径；其它消息不增加磁盘读取。
- 本次未重启、未部署、未 merge、未 push，也未关闭任何 session。

## 是否建议 upstream PR

**建议。** 这是基于持久控制面身份的通用修复，不依赖内部文案或特定 Bot 名称，并且
同时修复误建 session 与正式 report terminal race。PR 描述应重点说明 fail-open
边界、post-terminal trusted-host 限定，以及普通 bot 协作/人类/`@steer` 的保留矩阵。
