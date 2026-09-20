# Project OS 微信小程序制作方案

> 版本：v1.0 · 2026-09-20
> 依据：基于当前代码库实测（`server/src/auth.ts`、`session.ts`、`routes/auth.ts`、`config.ts`、`prisma/schema.prisma`）

## 1. 结论与范围

**可以低成本制作**。理由：项目已是 API 优先架构——后端 Fastify 独立运行，全部业务能力通过 `/api/v1/*` REST 接口暴露，权限模型（L1 / 项目级 L2 / L3 / 主管）在服务端判定。小程序作为第二个客户端接入，**网站与小程序读写同一份 PostgreSQL 数据，不存在也不需要"数据同步"**。

本方案范围：
- 微信小程序 MVP（第一期）
- 后端认证层适配（约 6 处改动）
- 数据库 1 次迁移
- 基础设施与合规清单

不在范围：流程图画布编辑（Web 核心场景，手机体验差）、微信订阅消息推送（沿用既有钉钉通知链路）、差旅系统（另行立项）。

## 2. 总体架构

```text
┌─────────────┐      ┌─────────────────┐
│  Web 前端    │      │  微信小程序(新)   │
│  React 19   │      │  Taro 4 (React) │
│  cookie 认证 │      │  Bearer 认证     │
└──────┬──────┘      └────────┬────────┘
       │  http(s)             │  https + wx.request
       ▼                      ▼
┌─────────────────────────────────────┐
│  Fastify API  ·  /api/v1/*          │
│  resolveActor 兼容 cookie 与 Bearer  │
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│  PostgreSQL（唯一数据源）             │
└─────────────────────────────────────┘
```

小程序端纯逻辑模块直接复用现有代码：`src/types.ts`、`src/workflow/schedule.ts`、`src/workflow/taskQueries.ts` 均为框架无关 TypeScript，可在 Taro 工程中 import。

## 3. 功能范围（MVP 分期）

按移动场景价值排序：

| 模块 | 能力 | 复用接口 |
|---|---|---|
| 登录与绑定 | 微信静默登录、绑定码绑定成员 | 新增 3 个端点 |
| 我的任务 | 跨项目任务列表、状态筛选、前置阻塞、任务详情 | 既有 published-tasks 接口 |
| 任务执行 | 开始/推进任务、提交交付物（拍照/文件） | 既有 deliverables 接口 |
| 审批中心 | 待办审批、通过/驳回、审批记录 | 既有 approvals 接口 |
| 通知中心 | 临期/超期/审批通知、已读确认 | 既有 notifications 接口 |
| 认领任务 | 浏览部门范围可认领任务、认领 | 既有 claim-tasks 接口 |
| 项目概览 | 只读仪表盘（进度、里程碑、健康度） | 既有 projects 接口 |

**明确不做**：流程图编辑、项目组合管理、成员管理、系统设置——这些是管理员的 Web 场景。

## 4. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | **Taro 4 + React 18 语法** | 与现有 Web 前端技术栈一致；可直接复用 `types.ts`、`schedule.ts` 等纯逻辑模块；一套心智 |
| 备选 | 原生小程序 | 无框架层、调试最直接；但 WXML/WXSS 与 React 差异大，且无法复用逻辑模块。若团队无 React 背景可选 |
| 语言 | TypeScript（严格模式） | 与主仓库一致 |
| 状态 | React 内置 state + context | MVP 不引入额外状态库 |
| 网络 | 封装 `request.ts`（wx.request Promise 化 + token 注入 + 401 重登） | 对应 Web 端 `src/http.ts` + `src/api.ts` 模式 |

## 5. 认证与账号绑定设计（核心）

### 5.1 现状事实（已核实）

- Session 已是标准 opaque token：`createOpaqueToken()` = `randomBytes(32).base64url`，库存 sha256，支持撤销与过期（默认 8h）
- `resolveActor()` 目前仅从 cookie `project_os_session` 读取
- `ExternalIdentityProvider` 枚举仅有 `DINGTALK`；`ExternalIdentity` 有 `corpId`（必填）+ `userId/unionId/openId` 三重唯一约束
- 钉钉 OAuth 是 Web 跳转流程，**无法在小程序内使用**，微信必须独立登录

### 5.2 登录流程（静默）

```text
小程序启动
  → wx.login() 取 code（无感，不需用户操作）
  → POST /api/v1/auth/wechat/login { code }
  → 后端 code2session(AppID+Secret) 得 openid
  → 查 ExternalIdentity(provider=WECHAT, corpId=AppID, openId=openid)
     ├─ 命中 → createServiceSession → 返回 { token, expiresAt }   ← 正常路径
     └─ 未命中 → 返回 { bindRequired: true } → 进入绑定流程
```

因 `wx.login()` 静默无感，**每次小程序启动都可静默换新 token**，8 小时 TTL 不构成体验问题（无需 refresh token 机制）。

### 5.3 绑定流程（绑定码方案）

避开 `getPhoneNumber`（需企业认证且按次收费 0.03 元/次），采用 Web 端签发绑定码：

```text
成员在 Web 端（已登录）
  → POST /api/v1/auth/wechat/bindcode → 生成 6 位码，10 分钟有效
  → 小程序端输入绑定码
  → POST /api/v1/auth/wechat/bind { wechatToken, bindCode }
  → 后端校验绑定码 → 将 openid 写入该成员的 ExternalIdentity
  → 下次启动静默登录直达
```

备选（管理员路径）：L1 在成员管理中手动录入成员 openid（复用现有 `/external-identities/dingtalk` 端点模式，新增 wechat 版）。

### 5.4 会话管理

- Session 表已有 `userAgent` / `ipHash` 字段，小程序会话 `userAgent` 记为 `wechat-miniprogram`
- Web 与小程序会话相互独立、各自可撤销；成员可在任一端 logout

## 6. 后端改造清单

| # | 文件 | 改动 | 规模 |
|---|---|---|---|
| 1 | `server/prisma/schema.prisma` | 枚举 `ExternalIdentityProvider` 增加 `WECHAT`；新增 `WechatBindingCode` 模型（memberId、codeHash、expiresAt、consumedAt） | ~15 行 |
| 2 | Prisma 迁移 | `prisma migrate dev --name wechat_login` | 1 个迁移 |
| 3 | `server/src/auth.ts` | `resolveActor()` 增加 `Authorization: Bearer <token>` 读取分支（优先级：cookie → Bearer → dev header） | ~6 行 |
| 4 | `server/src/config.ts` | 新增 `wechat` 配置段：appId、appSecret、organizationId、code2sessionUrl | ~8 行 |
| 5 | `server/src/wechat.ts`（新） | `code2Session()` 封装（对标 `dingtalk.ts` 模式：超时、错误分类） | ~60 行 |
| 6 | `server/src/routes/auth.ts` | 新增 3 端点：`POST /auth/wechat/login`、`POST /auth/wechat/bind`、`POST /auth/wechat/bindcode`（bindcode 需 Web session，bind/login 加入 auth 钩子白名单） | ~150 行 |
| 7 | `.env.example` | 新增 `WECHAT_MINIPROGRAM_APP_ID` / `WECHAT_MINIPROGRAM_SECRET` | 2 行 |
| 8 | `tests/wechatAuth.test.ts`（新） | 登录、绑定、未绑定拦截、会话撤销用例（对标现有 auth 测试风格） | ~120 行 |

改动总量约 350 行，**不触碰任何业务路由与权限逻辑**。

## 7. 小程序工程结构（Taro）

```text
miniprogram/
  src/
    app.ts / app.config.ts / app.scss
    request.ts            # wx.request 封装：token 注入、401 自动静默重登
    api/                  # 与 src/api.ts 对齐的客户端（仅 MVP 所需接口）
    pages/
      tasks/              # 我的任务（首页 tab）
      task-detail/        # 任务详情 + 交付物提交
      approvals/          # 审批中心（tab）
      notifications/      # 通知（tab）
      claim-tasks/        # 认领任务
      project-overview/   # 项目概览（只读）
      login-bind/         # 绑定码输入页（仅首次）
  project.config.json     # AppID 等微信配置
```

复用主仓库逻辑：通过相对路径或 pnpm workspace 引用 `src/types.ts`、`src/workflow/schedule.ts`。

## 8. 基础设施与合规清单（先于编码启动）

| 项 | 要求 | 备注 |
|---|---|---|
| HTTPS 域名 | 微信 request 合法域名必须 HTTPS | 证书 + Nginx 反代到 Fastify 8787 |
| ICP 备案 | 域名须已备案 | **周期最长（1–3 周），立即启动** |
| 小程序主体 | 企业主体（个人主体类目受限） | 复用公司营业执照 |
| 类目 | 工具 > 效率（或商务服务类目） | 内部管理工具通常可过审；提审时可能被要求补充说明 |
| 隐私申报 | 收集 openid 属于个人信息，需在小程序后台申报隐私接口 | 不调用手机号/位置等敏感接口（绑定码方案已规避） |
| 后端公网暴露 | 8787 只暴露 `/api/v1/*` + healthz；管理端点仅内网 | 建议网关层按路径分流 |

## 9. 实施里程碑

| 阶段 | 内容 | 工期 | 出口标准 |
|---|---|---|---|
| M0 合规启动 | 注册小程序、启动域名备案、申请证书 | 与开发并行 | 备案提交回执 |
| M1 后端改造 ✅ **已完成 2026-09-20** | 第 6 节全部 8 项（含 QA 复审后 L1/L2 修复） | 0.5 周 | ✅ `pnpm test:all` 92 项全绿（84 项既有基线零回归 + 8 项微信新增） |
| M2 小程序骨架 | Taro 工程、request 封装、登录绑定闭环 | 1 周 | 真机可登录并看到"我的任务"真实数据 |
| M3 任务与通知 | 任务详情、状态更新、交付物提交、通知中心 | 1 周 | 手机提交交付物 → Web 端可见且审批链路触发 |
| M4 审批与认领 | 审批中心、认领任务、项目概览 | 1 周 | 全部 MVP 页面可用 |
| M5 提审上线 | 真机回归、体验优化、提审 | 0.5 周 | 审核通过、生产环境验证 |

**总工期约 4 周**（单人全力）；关键路径是 M0 的域名备案，务必立即启动。

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 域名备案延迟 | 阻塞真机联调与提审 | M0 立即启动；开发期用微信开发者工具"不校验合法域名"选项 |
| 小程序审核被拒 | 上线延期 | 类目选工具>效率；准备企业内部使用说明；避开敏感接口 |
| Taro 框架坑（样式/分包兼容） | 开发返工 | 骨架期（M2）先验证关键页面真机渲染；不行则降级原生 |
| 微信身份与钉钉身份并存 | 成员两套身份混乱 | 绑定码绑定到同一 Member；成员管理页展示全部身份 |
| 通知触达分裂 | 用户困惑 | 小程序内不做推送，通知仍走钉钉（既有链路）；小程序通知中心仅主动查看 |
| 8h Session 过期 | 使用中断 | 每次启动静默 wx.login 换新 token（见 5.2） |

## 11. 验收标准

1. 手机端登录后所见数据与 Web 端一致（同一 PostgreSQL 单一数据源）
2. Web 端修改任务状态 → 小程序下拉刷新即可见，**无同步延迟**
3. 小程序提交交付物 → Web 端可见，OA 审批通知正常触发（既有链路不回归）
4. 未绑定成员无法看到任何业务数据（绑定前仅可见绑定页）
5. 主仓库 `pnpm test:all` 84 项既有测试零回归，新增 wechat 认证测试全绿
6. Session 撤销后小程序立即失去访问能力（Bearer token 同样走 revokedAt 校验）

## 12. 备选路线备忘（钉钉）

若使用者以内部员工为主，钉钉 H5 微应用是更省的路线：免登直接复用 `dingtalk.ts` 适配层，通知与 OA 审批链路已打通，无需新建微信身份体系。本方案的 Bearer token 改造（第 6 节 #3）对两条路线通用，先行落地不浪费。

## 13. 路线决策记录

| 日期 | 决策 |
|---|---|
| 2026-09-20 | **采用微信小程序路线。范围严格限定在小程序，不采用第 12 节钉钉备选路线。** |

### 已确认的业务前提

- 使用者：**公司内部**
- **不开通微信支付/收款账号**（无收付款场景，免去商户号申请与支付资质审核）

### 范围边界（本次锁定）

**范围内：**

1. 第 6 节后端改造 8 项（认证层，约 350 行）
2. 第 3 节 MVP 功能：我的任务、任务执行与交付物、审批中心、通知中心、认领任务、项目概览
3. 第 8 节基础设施与合规：HTTPS、ICP 备案、域名白名单、主体资质
4. 第 9 节 M1–M5 里程碑

**明确不做（本期范围外）：**

| 不做项 | 原因 |
|---|---|
| 钉钉 H5 / 钉钉小程序 | 已决策不走该路线 |
| 微信支付 / 收款账号 | 公司内部使用，无收付款场景 |
| 小程序端流程图编辑 | 手机画布体验差，保留为 Web 场景 |
| 差旅系统 | 独立立项 |
| 物料管理系统双向同步 | 独立立项 |
| 微信订阅消息推送 | 通知继续走既有钉钉链路 |
| 风险 / 成本 / 工时页真实数据化 | 属主仓库既有遗留项，与本方案范围无关 |

## 14. M1 交付记录（2026-09-20）

状态：**✅ 已完成并通过独立验证**

### 交付内容

| 文件 | 改动 |
|---|---|
| `server/prisma/schema.prisma` | `ExternalIdentityProvider` 加 `WECHAT`；新增 `WechatBindingCode`（`codeHash` 唯一）+ `Member` 反向关系 |
| `server/prisma/migrations/20260920062417_wechat_login/` | 迁移：`ALTER TYPE` 加枚举值 + 建表 + 索引 + 外键 |
| `server/src/auth.ts` | `resolveActor()` 优先级 **cookie → Bearer → dev header**；白名单加 `wechat/login`、`wechat/bind`（`bindcode` 不入） |
| `server/src/wechat.ts`（新） | `code2Session()`；HMAC 无状态绑定令牌；绑定失败滑动窗口限流 |
| `server/src/routes/auth.ts` | 新增 3 端点（login / bind / bindcode） |
| `server/src/config.ts` | 新增 `wechat` 配置段 |
| `server/.env.example`、根 `.env.example` | 补全全部微信相关 env（含 `WECHAT_BIND_*` 逐项注释） |
| `package.json` | 新增 `test:wechat` 并接入 `test:all` |
| `tests/wechatAuth.test.ts`（新） | 8 个用例 |

### 端点契约

| 端点 | 鉴权 | 行为 |
|---|---|---|
| `POST /api/v1/auth/wechat/login` | 免 | 已绑定 → `{ token, expiresAt }`；未绑定 → `{ bindRequired: true, token, expiresAt }`（token 为短时绑定令牌） |
| `POST /api/v1/auth/wechat/bind` | 免 | 入参 `{ token, bindCode }` → 绑定成功返回新 session |
| `POST /api/v1/auth/wechat/bindcode` | **需登录** | 生成 6 位绑定码，10 分钟有效 |

### 关键设计决策：绑定令牌（方案补全）

方案原文未定义 `bind` 的 openid 来源。实现采用：`login` 未绑定时额外返回**短时绑定令牌**（HMAC 无状态签名，承载 openid，10 分钟）。

理由：客户端无法伪造他人 openid；相比「重传 wx code」（一次性、5 分钟），令牌方案体验更好且无需二次调用微信。

### 防爆破强度

6 位数字 + 10 分钟 TTL + **一次性原子消费** + 同一成员仅保留最新码 + 同 openid 失败限流（默认 5 次/10 分钟，超限 429）。单窗口猜中概率 ≤ 5/10⁶。码不存在/过期/已消费/并发落败**统一返回 400**，不泄露状态。

### 验证结果

- `pnpm test:all` → **92 项全绿**（84 项既有基线零回归 + 8 项微信新增）
- `pnpm lint` / `pnpm api:typecheck` → 通过
- **独立安全验证**：QA 自建后端实例 + 伪造微信上游，**58 项真实 HTTP 攻击断言全部通过**，判定 `NoOne`（无源码缺陷）。证据见 `.qa/wechat-auth-verify/REPORT.md`
- 重点验证通过项：未绑定令牌访问业务接口全部 401；绑定令牌篡改/过期/跨 AppID 全 401；并发消费原子性成立；白名单不可绕过；AppSecret 无泄露

### 已知限制（需在生产前处理）

| 限制 | 影响 | 处理时机 |
|---|---|---|
| 绑定码限流为**进程内 Map** | 多实例部署时限流不共享 | 后端扩容前换 Redis |
| 真实 AppID / Secret 未配置 | `/wechat/login` 返回 503 | **M2 真机联调前必须补进 `.env`** |
| 真实 `code2session` 未联调 | 微信侧异常码路径未在真实环境验证 | M2 联调时验证 |
