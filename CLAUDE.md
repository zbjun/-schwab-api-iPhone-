# THS · 基于 Schwab API 的个人 iPhone 交易客户端

和用户交流用中文。这个项目连着**真实券商账户**，安全规则优先于速度。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `mobile/` | 当前主线：Expo SDK 57 / React Native 0.86 / React 19.2 / TypeScript 6。改 Expo 代码前先读 `mobile/AGENTS.md` 指向的 v57 文档 |
| `server/` | Node 24 共享网关（无依赖），直接 import `mobile/src` 里的 `broker.ts`、`orderRules.ts`、`chartData.ts` 等；部署在阿里云，见 `server/DEPLOYMENT.md` |
| `server/mexc*`、`mobile/src/mexc*`、`mobile/src/MexcClient.ts`、`mobile/src/mexc/` | MEXC 永续合约：独立网关、独立主机、独立保险库，复用 `gateway.mjs` 的认证、核对和写锁 |
| `ios/`、根目录 `app.json`/`eas.json` | 旧 SwiftUI 版，不再开发 |
| `tools/` | IPA 注入与校验、行情诊断、测速脚本 |
| `artifacts/`、`.secrets/`、`.env` | 被 Git 忽略的私密产物与凭据，见下方规则 |

## 常用命令

```bash
npm --prefix mobile run typecheck
npm --prefix mobile test          # node --test src/*.test.ts
npm --prefix mobile run export:web
npm --prefix server test
```

网页预览：`.claude/launch.json` 的 `mobile-web`（演示账户）。`/?preview=history&range=intraday|fiveDay` 用 `mobile/public/market-preview/` 里的真实行情快照预览图表。

## 硬性规则

1. **不碰真实交易**：不下单、不改单、不撤单，不建真实定时单，Schwab 和 MEXC 都一样。验证用演示账户和测试夹具。真实账户只能做只读行情查询，并且要先经用户同意。第一笔真实 MEXC 单由用户自己在 app 里下。
2. **交易安全模型不能削弱**：60 秒一次性核对、写请求绝不重试、结果未知时写入持久标记并锁住写操作、两台设备共用写锁、可卖股数预留（OCO 只占用一次）、旧网关不下止盈止损单。MEXC 另有：只有文档明确的拒绝码才解锁（`DEFINITE_REJECTIONS` 只能加能证明未成交的码）、杠杆和单笔金额上限由服务器校验、市价单发成带保护价的 IOC、key 未绑 IP 或能转账就关闭下单（服务器配置 `keyCheck: false` 可关闭这项检查，用于不开现货账户读的 key，此时由用户自己在 MEXC 页面保证）。改这些代码必须补测试。
3. **机密**：`.env`、`.secrets/`、`artifacts/server-device-configs/` 永远不打印、不提交、不发给外部服务。服务器域名、IP 和 Nginx 站点名只能写成 `<gateway-origin>`、`<gateway-host>`、`<existing-site>.conf`，真实值只在 `.secrets/deploy-target.md`；MEXC 网关写成 `<mexc-host>`，真实值只在 `.secrets/mexc-target.md`。MEXC key 只放在 MEXC 网关的服务器配置里，由用户自己写入，不进聊天、不进仓库、不进手机。
4. **Git**：只在用户要求时提交或推送。推送前逐一比对上述机密值和服务器地址，只报告"有/无匹配"。2026-10-18 改写过历史，不要从那之前的克隆推送。
5. **部署服务器**：必须由用户在当前会话里亲口同意。按 `server/DEPLOYMENT.md` 新建 release 目录，先在服务器的 Node 上跑全部测试；重启前确认两台设备 `unresolvedOperation=false`、`scheduled` 里没有待执行项；保留上一个 release 用于回滚，并更新部署记录（只用占位符）。本机时钟可能不准，判断美股时段要以服务器或外部标准时间为准。
6. **出 IPA**：在 `mobile/` 里同步修改版本号和 build 号，涉及 `app.json`（`version`、`buildNumber`）、`package.json`、`package-lock.json` 开头两处本项目版本号、`.eas/build/unsigned-ios.yml`、`scripts/build-unsigned-ios.sh`、`scripts/verify-ipa.py`。EAS 云端构建前要确认用户确实要出包。设备包用 `mobile/scripts/personalize-ipa.py` 在本机注入配置，再用 `mobile/scripts/verify-ipa.py --allow-personal-config` 校验。
7. **K 线逻辑**（`MarketChart.tsx` 的绘图与数据处理）不要随界面改动一起改，除非任务本身就是图表问题。

## 子 agent 分工

本项目**允许并鼓励**使用子 agent。目标是在质量不打折的前提下把成本降到最低：**每件事交给能稳定做好它的最便宜的模型**，Opus 只做真正需要它的判断。

| 模型（相对成本） | 擅长 | 本项目里负责 |
| --- | --- | --- |
| Haiku 5.5（最低） | 照着做、找东西、跑命令 | `scout`：查代码位置、读文件做摘要、跑测试并归纳失败<br>`implementer`：方案已写到步骤级的小改动，比如文案、样式、补测试、文档、机械重构、按给定签名实现纯函数 |
| Sonnet 5.5（中等） | 在给定边界内自己补全细节 | `builder`：大部分功能实现，比如新组件或页面、多文件改动、图表与导出等数据处理、服务器只读接口、能复现的 bug<br>`reviewer`：一般改动的代码审查 |
| Opus 5.5（最高） | 拆需求、做取舍、守安全 | 主会话：需求澄清、方案与架构取舍、难以复现的问题、高风险代码、最终验收、和用户沟通<br>`safety-reviewer`：高风险改动的只读审查 |

**高风险代码**由主会话（Opus）亲自写，并且必须经过 `safety-reviewer` 审查，不交给 Haiku 或 Sonnet 写。范围包括：`orderRules.ts` 与 `broker.ts` 的下单路径、可卖股数预留、`gateway.mjs` 写锁、`server/schedule.mjs`、`vault.mjs`、`ServerBroker.ts` 的写请求与回执、`mexcRules.ts`、`server/mexcBroker.ts`、`MexcClient.ts`、OAuth、部署脚本、改写 Git 历史。

### 省钱规则

1. **主会话保持轻量**：要了解代码时先派 `scout` 找位置、做摘要，不要自己通读大文件；只读做决定真正需要的那几段。
2. **从最便宜的开始，失败再升级**：能写成步骤的交给 `implementer`；只能写成目标和边界的交给 `builder`。`implementer` 卡住或做错两次就改派 `builder`；`builder` 卡住两次再由主会话接手。
3. **审查也分级**：一般改动先由 `reviewer` 审查，主会话读它的报告，再抽查关键几处；高风险改动交给 `safety-reviewer`，主会话自己通读 diff。
4. **少开、开大**：每次派 agent 都要冷启动重读上下文。给一个 agent 一块完整、能独立验证的工作，不要拆成很多小任务；几行、一个文件的改动由主会话直接改。
5. **能并行就并行**：互不相关、改不同文件的任务同时派出。
6. **推理强度**：调用时设置 `effort`，`scout` 和 `implementer` 用 `low`，`builder` 和 `reviewer` 用 `medium`，`safety-reviewer` 用 `high`。

### 委派流程

1. 主会话澄清需求，需要时先派 `scout` 摸清相关代码。
2. 主会话写交接说明，按接手模型调整详细程度：
   - **给 `implementer`**：目标、可改文件清单、接口签名、逐步做法、不能动的东西、要加的测试和要跑的命令。写到不需要再做设计判断的程度。
   - **给 `builder`**：目标、可改文件范围、关键约束和不能动的东西、验收标准（行为和测试）。实现细节留给它。
3. 子 agent 实现，跑类型检查和测试，按固定格式汇报改动、测试结果和疑问。超出范围或说明没覆盖的情况必须停下来报告。
4. 审查：一般改动交给 `reviewer`，高风险改动交给 `safety-reviewer`；有问题就退回原 agent 修改，或升级处理。
5. 主会话做最终验收：看 `git diff --stat` 和审查报告，自己跑一遍类型检查、客户端和服务器测试（需要时在网页预览里实测），然后才向用户汇报"完成了"。

### 边界

- **不能让两个 agent 同时改同一个文件。**
- 子 agent 一律不提交、不推送、不部署、不构建 IPA、不 ssh、不调用真实账户或网关；这些只由主会话在用户同意后执行。
- 子 agent 的报告是线索不是结论：没看过 diff、没跑过测试，主会话不能告诉用户"完成了"。
- 如果主会话本身不是 Opus，高风险代码的实现和审查仍然要交给 Opus（`safety-reviewer`，或请用户切换模型）。
