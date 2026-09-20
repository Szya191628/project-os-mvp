# Project OS API

当前后端是一个模块化单体，使用 Fastify + Prisma + PostgreSQL。前端项目列表和项目流程图已通过 API 读取真实数据库，项目、流程草稿/发布和任务写入接口也已接入；三级权限和钉钉登录会话适配已接入。

## 本地启动

1. 复制根目录 `.env.example` 为 `.env`。
2. 启动 PostgreSQL：

   ```bash
   docker compose up -d db
   ```

3. 初始化数据库：

   ```bash
   pnpm db:generate
   pnpm db:migrate:deploy
   pnpm db:seed
   ```

4. 启动 API：

   ```bash
   pnpm api:dev
   ```

## 首版接口

- `GET /healthz`：进程存活检查。
- `GET /readyz`：数据库就绪检查。
- `GET /api/v1/projects`：读取组织下的项目列表。
- `GET /api/v1/projects/:projectId/workflow`：读取项目当前草稿流程及节点、连线、排期。
- `GET /api/v1/projects/:projectId/assignee-options`：读取该项目所属组织内的全部在职成员，供 L1/L2 分配任务负责人；项目成员管理接口仍只返回已加入项目的成员。
- `POST /api/v1/projects`：创建项目并初始化空流程。
- `PUT /api/v1/projects/:projectId/workflow/draft`：保存流程草稿（节点、连线、日历和任务属性）。
- `PUT /api/v1/projects/:projectId/workflow/published`：更新当前已发布流程内容。
- `POST /api/v1/projects/:projectId/workflow/publish`：将草稿发布为新版本。
- `POST /api/v1/projects/:projectId/tasks`：在流程中新增任务节点。
- `PATCH /api/v1/tasks/:taskId`：更新任务负责人、工期、进度、实际时间和完成信息。
- `GET /api/v1/auth/me`：读取当前登录成员及基础角色。
- `GET /api/v1/auth/dingtalk/start`：创建 OAuth 状态并跳转到钉钉授权页。
- `GET /api/v1/auth/dingtalk/callback`：校验回调状态、映射钉钉成员并建立 HttpOnly 会话。
- `POST /api/v1/auth/logout`：撤销当前会话并清除 Cookie。
- `POST /api/v1/organizations/:organizationId/members/:memberId/external-identities/dingtalk`：由 L1 绑定成员的钉钉 `corpId` 和 `userid`。
- `POST /api/v1/organizations/:organizationId/members/sync-dingtalk`：由 L1 读取钉钉通讯录，更新成员的姓名、所属部门和直属主管；未映射的钉钉成员会自动创建为 L3。
- 钉钉群机器人：设置 `DINGTALK_BOT_ENABLED=true` 后，服务端通过 Stream 模式接收机器人消息；群内发送 `@Project Agent` 的自然语言问题，Agent 会按发送者对应的 Project OS 权限处理。写操作会先保存为当前会话的待确认动作，发送“确认”后才调用现有写入接口，发送“取消”则放弃。首版待确认动作保存在 API 进程内，重启服务后需要重新发起操作。
- `GET /api/v1/organizations/:organizationId/members`：读取组织成员目录及项目级 L2 授权（仅 L1）。
- `GET /api/v1/projects/:projectId/access`：读取项目成员、可添加成员和项目级 L2 授权（L1/L2）。
- `POST /api/v1/projects/:projectId/access/l2`：授予项目级 L2（L1 或当前项目 L2）。
- `DELETE /api/v1/projects/:projectId/access/l2/:memberId`：撤销项目级 L2（L1 或当前项目 L2）。
- `POST/DELETE /api/v1/organizations/:organizationId/members/:memberId/system-roles/:roleCode`：管理 L1/L2/L3 全局角色（仅 L1）；全局 L2 获得新建并发布自己创建项目的资格，新项目会自动授予其项目级 L2。
- `POST/DELETE /api/v1/projects/:projectId/members/:memberId`：管理项目成员（L1/L2）。
- `POST /api/v1/tasks/:taskId/assignees`、`DELETE /api/v1/tasks/:taskId/assignees/:memberId`：管理任务多负责人（L1/L2）。
- `DELETE /api/v1/tasks/:taskId`、`POST /api/v1/tasks/:taskId/restore`：逻辑删除和恢复任务（L1/L2）。

开发阶段可通过 `x-member-id` 请求头模拟当前成员；未提供时使用 `DEFAULT_MEMBER_ID`。要在本地测试真实钉钉登录，请将 `ALLOW_DEV_MEMBER_HEADER=false` 后重启 API；生产环境必须关闭该开关并接入真实会话。组织从当前成员归属解析，未提供成员时才回退到 `DEFAULT_ORGANIZATION_ID`。

钉钉登录需要配置 `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_CORP_ID`、`DINGTALK_ORGANIZATION_ID` 和 `DINGTALK_REDIRECT_URI`。回调只接受预先保存且未过期的 OAuth 状态；首次登录且尚未绑定的钉钉账号会自动创建为当前组织的 L3 在职成员，并保存钉钉身份映射。已有 Project OS 成员仍可由 L1 在人员页面手动绑定钉钉 `userid`。

钉钉通讯录同步还需要在应用权限中开通“成员信息读取权限”（`qyapi_get_member`）、“通讯录部门信息读取权限”（`qyapi_get_department_list`）和“通讯录部门成员读取权限”（`qyapi_get_department_member`）。同时要在钉钉应用的通讯录授权范围中包含要同步的部门及其成员；否则会返回“部门/成员不在授权范围内”。同步会读取部门树和部门成员详情，按钉钉 `userid` 关联 Project OS 成员，并将 `manager_userid` 映射为直属主管关系。

群机器人默认复用企业内部应用的 `DINGTALK_CLIENT_ID`/`DINGTALK_CLIENT_SECRET`；如果机器人使用独立应用，可改用 `DINGTALK_BOT_CLIENT_ID` 和 `DINGTALK_BOT_CLIENT_SECRET`。在钉钉开发者后台进入“应用能力 → 添加应用能力 → 机器人”，选择 Stream 模式并发布。Stream 模式不需要给钉钉暴露 HTTP 回调地址，但运行 Project OS 的服务器必须能够访问钉钉开放平台。生产环境建议关闭 `ALLOW_DEV_MEMBER_HEADER`，并在钉钉应用测试范围和群成员范围内验证发送者权限。
