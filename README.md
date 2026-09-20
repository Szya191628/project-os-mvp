# Project OS MVP

一个面向企业项目经理、PMO 与团队负责人的现代项目管理前端原型。第一阶段专注项目组合、项目计划、WBS、甘特图、任务依赖、里程碑、资源负载、工时、风险、成本和 AI Agent 入口。

## 运行

```bash
pnpm install
pnpm dev
```

生产构建与检查：

```bash
pnpm lint
pnpm build
```

## 当前页面

- 项目组合：健康度、里程碑、资源和预算概览
- 项目列表：搜索、状态筛选、负责人和进度
- 我的任务：按当前成员汇总跨项目任务、前置阻塞、计划日期和工时
- 项目工作台：WBS、甘特图、依赖、里程碑和任务详情抽屉
- 资源负载：跨项目任务汇总、六周负载热力图、技能覆盖和可调配容量
- 工时：周工时表、审批状态和汇总
- 风险：概率 × 影响矩阵、风险台账和响应建议
- 成本：预算、实际、承诺成本、趋势和项目明细
- Project Agent：统一意图入口，支持项目组合、排期顺延、资源负载、交付物闭环、流程草稿预览和发布确认

项目与流程数据通过 API 读取 PostgreSQL；风险、工时和成本页面仍保留部分演示数据。核心类型位于 `src/types.ts`，前端演示默认值位于 `src/data.ts`。

Agent V1 使用确定性的意图路由：自然语言先识别为分析、排期模拟、流程生成或发布确认，再调用同一份项目/流程数据。流程生成只返回草稿预览，发布必须回到项目流程图由发布者明确确认。

后端与数据库设计基线见 [`BACKEND_DESIGN.md`](BACKEND_DESIGN.md)，领域词汇见 [`CONTEXT.md`](CONTEXT.md)。后端首版位于 `server/`，本地数据库由 `docker-compose.yml` 提供。

当前已确认的 L1/L2/L3 系统角色、项目级 L2 授权、任务执行边界和审计规则见 [`PERMISSIONS_SPEC.md`](PERMISSIONS_SPEC.md)。

后端启动（先复制根目录 `.env.example` 为 `.env`，再启动数据库并执行迁移）：

```bash
docker compose up -d db
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm api:dev
```

API 默认地址为 `http://127.0.0.1:8787`，健康检查为 `/healthz`，就绪检查为 `/readyz`。本地开发环境变量参考 [`server/.env.example`](server/.env.example)。

本地后台运行时，请将前后端标准输出和错误输出统一重定向到 `tmp/run/`；根目录中已有的历史日志暂不处理。

## 后续钉钉接入边界

当前已接入钉钉登录适配层，并支持通过企业机器人 Stream 模式把群消息路由到 Project Agent；具体 SDK/API 凭据通过服务端环境变量配置。核心项目模型不依赖钉钉：

- 身份与组织：将钉钉 `userid` 映射为 Project OS 成员 ID
- 消息与待办：把里程碑、风险和审批动作投递到钉钉
- 群机器人：群内 `@Project Agent` 后按发送者的 Project OS 权限查询或生成写入确认动作
- OA 审批：成本变更、项目立项和重大风险决策通过审批实例关联
- 免登：在应用入口完成授权，核心项目模型保持平台无关

## 核心模型

`Project → Task/WBS → Dependency → Milestone → Assignment → Timesheet`

治理模型与项目并行：`Risk`、`Cost/Budget`、`Portfolio`。成员与组织身份保持独立，为未来钉钉适配留出清晰边界。
