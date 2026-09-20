import 'dotenv/config'
import path from 'node:path'

export const DEFAULT_APPROVAL_POLL_INTERVAL_MS = 15 * 60 * 1000
export const DEFAULT_APPROVAL_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000

const numberFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const booleanFromEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback
  return value.toLowerCase() === 'true'
}

const dingtalkClientId = process.env.DINGTALK_CLIENT_ID ?? ''
const dingtalkClientSecret = process.env.DINGTALK_CLIENT_SECRET ?? ''
const dingtalkRedirectUri = process.env.DINGTALK_REDIRECT_URI ?? ''
const dingtalkCorpId = process.env.DINGTALK_CORP_ID ?? ''
const dingtalkUserDetailsUrl = process.env.DINGTALK_USER_DETAILS_URL ?? 'https://oapi.dingtalk.com/topapi/v2/user/get'
const dingtalkDepartmentDetailsUrl = process.env.DINGTALK_DEPARTMENT_DETAILS_URL ?? 'https://oapi.dingtalk.com/topapi/v2/department/get'
const dingtalkDepartmentListIdsUrl = process.env.DINGTALK_DEPARTMENT_LIST_IDS_URL ?? 'https://oapi.dingtalk.com/topapi/v2/department/listsubid'
const dingtalkDepartmentUsersUrl = process.env.DINGTALK_DEPARTMENT_USERS_URL ?? 'https://oapi.dingtalk.com/topapi/v2/user/list'
const defaultOrganizationId = process.env.DEFAULT_ORGANIZATION_ID ?? ''
const piAgentApiKey = process.env.PI_AGENT_API_KEY ?? ''
const wechatAppId = process.env.WECHAT_MINIPROGRAM_APP_ID ?? ''
const wechatAppSecret = process.env.WECHAT_MINIPROGRAM_SECRET ?? ''
const wechatOrganizationId = process.env.WECHAT_MINIPROGRAM_ORGANIZATION_ID ?? defaultOrganizationId

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: numberFromEnv(process.env.PORT, 8787),
  apiOrigin: process.env.PUBLIC_API_ORIGIN ?? `http://127.0.0.1:${numberFromEnv(process.env.PORT, 8787)}`,
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173',
  defaultOrganizationId,
  // Local development keeps the demo usable before DingTalk login is wired.
  // Production deployments must provide a real session instead.
  defaultMemberId: process.env.DEFAULT_MEMBER_ID ?? '00000000-0000-0000-0000-000000000101',
  allowDevMemberHeader: process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_MEMBER_HEADER !== 'false',
  cookieSecure: booleanFromEnv(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'project_os_session',
  sessionTtlSeconds: numberFromEnv(process.env.SESSION_TTL_SECONDS, 60 * 60 * 8),
  dingtalk: {
    clientId: dingtalkClientId,
    clientSecret: dingtalkClientSecret,
    corpId: dingtalkCorpId,
    organizationId: process.env.DINGTALK_ORGANIZATION_ID ?? defaultOrganizationId,
    redirectUri: dingtalkRedirectUri,
    scope: process.env.DINGTALK_SCOPE ?? 'openid',
    authorizationUrl: process.env.DINGTALK_AUTHORIZATION_URL ?? 'https://login.dingtalk.com/oauth2/auth',
    tokenUrl: process.env.DINGTALK_TOKEN_URL ?? 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    appAccessTokenUrl: process.env.DINGTALK_APP_ACCESS_TOKEN_URL ?? 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    userInfoUrl: process.env.DINGTALK_USER_INFO_URL ?? 'https://api.dingtalk.com/v1.0/contact/users/me',
    userDetailsUrl: dingtalkUserDetailsUrl,
    departmentDetailsUrl: dingtalkDepartmentDetailsUrl,
    departmentListIdsUrl: dingtalkDepartmentListIdsUrl,
    departmentUsersUrl: dingtalkDepartmentUsersUrl,
    rootDepartmentId: process.env.DINGTALK_ROOT_DEPARTMENT_ID ?? '1',
    requestTimeoutMs: numberFromEnv(process.env.DINGTALK_REQUEST_TIMEOUT_MS, 8000),
    apiBudget: {
      enabled: booleanFromEnv(process.env.DINGTALK_API_BUDGET_ENABLED, true),
      monthlyLimit: Math.max(1, numberFromEnv(process.env.DINGTALK_API_MONTHLY_LIMIT, 5000)),
      reserve: Math.max(0, numberFromEnv(process.env.DINGTALK_API_MONTHLY_RESERVE, 500)),
    },
    bot: {
      enabled: booleanFromEnv(process.env.DINGTALK_BOT_ENABLED, false),
      mode: process.env.DINGTALK_BOT_MODE ?? 'stream',
      clientId: process.env.DINGTALK_BOT_CLIENT_ID ?? dingtalkClientId,
      clientSecret: process.env.DINGTALK_BOT_CLIENT_SECRET ?? dingtalkClientSecret,
      requireMention: booleanFromEnv(process.env.DINGTALK_BOT_REQUIRE_MENTION, true),
      proactiveEnabled: booleanFromEnv(process.env.DINGTALK_BOT_PROACTIVE_ENABLED, true),
      otoMessageUrl: process.env.DINGTALK_BOT_OTO_MESSAGE_URL ?? 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      debug: booleanFromEnv(process.env.DINGTALK_BOT_DEBUG, false),
      get available() { return this.enabled && this.mode === 'stream' && Boolean(this.clientId && this.clientSecret && dingtalkCorpId && (process.env.DINGTALK_ORGANIZATION_ID ?? defaultOrganizationId)) },
    },
    get enabled() { return Boolean(dingtalkClientId && dingtalkClientSecret && dingtalkCorpId && dingtalkRedirectUri && (process.env.DINGTALK_ORGANIZATION_ID ?? defaultOrganizationId)) },
  },
  // 微信小程序登录（方案 §5.2 / §5.3）：code2session 换取 openid；未绑定成员用 Web 端
  // 签发的 6 位绑定码完成账号绑定。小程序会话与 Web 会话相互独立。
  wechat: {
    appId: wechatAppId,
    appSecret: wechatAppSecret,
    organizationId: wechatOrganizationId,
    code2sessionUrl: process.env.WECHAT_MINIPROGRAM_CODE2SESSION_URL ?? 'https://api.weixin.qq.com/sns/jscode2session',
    requestTimeoutMs: numberFromEnv(process.env.WECHAT_MINIPROGRAM_REQUEST_TIMEOUT_MS, 8000),
    // 未绑定登录时签发的短时绑定令牌（仅承载 openid，HMAC 签名，不含任何敏感凭据）。
    bindTokenSecret: process.env.WECHAT_BIND_TOKEN_SECRET ?? (wechatAppSecret || 'project-os-wechat-bind-dev-secret'),
    bindTokenTtlMs: numberFromEnv(process.env.WECHAT_BIND_TOKEN_TTL_MS, 10 * 60 * 1000),
    // 绑定码有效期与防爆破阈值（同一 openid 在时间窗内的失败次数上限）。
    bindCodeTtlMs: numberFromEnv(process.env.WECHAT_BIND_CODE_TTL_MS, 10 * 60 * 1000),
    bindCodeMaxAttempts: Math.max(1, numberFromEnv(process.env.WECHAT_BIND_CODE_MAX_ATTEMPTS, 5)),
    bindCodeAttemptWindowMs: numberFromEnv(process.env.WECHAT_BIND_CODE_ATTEMPT_WINDOW_MS, 10 * 60 * 1000),
    get enabled() { return Boolean(this.appId && this.appSecret && this.organizationId) },
  },
  // 钉钉 OA 审批集成：L3 通过钉钉审批流提交阶段/最终交付物；附件同步到
  // TaskDeliverable，只有最终交付审批通过后才自动完成任务并解锁下游。
  approval: {
    processCode: process.env.DINGTALK_APPROVAL_PROCESS_CODE ?? '',
    // 审批表单里"交付物附件"控件的名称，用于从 formComponentValues 中定位附件。
    attachmentField: process.env.DINGTALK_APPROVAL_ATTACHMENT_FIELD ?? '交付物附件',
    // 事件订阅（审批状态回调）凭据；未配置时依赖 worker 轮询兜底。
    callbackToken: process.env.DINGTALK_CALLBACK_TOKEN ?? '',
    callbackAesKey: process.env.DINGTALK_CALLBACK_AES_KEY ?? '',
    callbackEnabled: booleanFromEnv(process.env.DINGTALK_CALLBACK_ENABLED, true),
    // 审批轮询是回调不可用时的补偿机制，不能跟随通知 worker 的高频检查。
    pollEnabled: booleanFromEnv(process.env.DINGTALK_APPROVAL_POLL_ENABLED, false),
    pollIntervalMs: Math.max(DEFAULT_APPROVAL_POLL_INTERVAL_MS, numberFromEnv(process.env.DINGTALK_APPROVAL_POLL_INTERVAL_MS, DEFAULT_APPROVAL_POLL_INTERVAL_MS)),
    pollBatchSize: numberFromEnv(process.env.DINGTALK_APPROVAL_POLL_BATCH_SIZE, 10),
    createInstanceUrl: process.env.DINGTALK_WORKFLOW_CREATE_INSTANCE_URL ?? 'https://api.dingtalk.com/v1.0/workflow/processInstances',
    getInstanceUrl: process.env.DINGTALK_WORKFLOW_GET_INSTANCE_URL ?? 'https://api.dingtalk.com/v1.0/workflow/processInstances',
    downloadFileUrl: process.env.DINGTALK_WORKFLOW_DOWNLOAD_FILE_URL ?? 'https://api.dingtalk.com/v1.0/workflow/processInstances/spaces/files/urls/download',
    // 审批通过时默认只保存附件引用；用户首次查看/下载时再从钉钉取回并缓存。
    downloadAttachmentsOnApproval: booleanFromEnv(process.env.DINGTALK_APPROVAL_DOWNLOAD_ATTACHMENTS_ON_APPROVAL, false),
    // 外部实例发现（文档 §8）：按模板列实例的接口与回扫时间窗。
    getInstanceListUrl: process.env.DINGTALK_WORKFLOW_INSTANCE_LIST_URL ?? 'https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query',
    discoveryEnabled: booleanFromEnv(process.env.DINGTALK_APPROVAL_DISCOVERY_ENABLED, false),
    // 外部发现更昂贵，且只用于回调丢失时补偿；强制设置安全下限。
    discoveryIntervalMs: Math.max(DEFAULT_APPROVAL_DISCOVERY_INTERVAL_MS, numberFromEnv(process.env.DINGTALK_APPROVAL_DISCOVERY_INTERVAL_MS, DEFAULT_APPROVAL_DISCOVERY_INTERVAL_MS)),
    discoveryWindowMs: numberFromEnv(process.env.DINGTALK_APPROVAL_DISCOVERY_WINDOW_MS, 24 * 60 * 60 * 1000),
    // 交付物安全查看链接签名密钥（文档 §6.3）
    viewTokenSecret: process.env.DELIVERABLE_VIEW_SECRET ?? (dingtalkClientSecret || 'project-os-view-dev-secret'),
    viewTokenTtlMs: numberFromEnv(process.env.DELIVERABLE_VIEW_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    get enabled() { return Boolean(this.processCode) },
    get callbackConfigured() { return Boolean(this.callbackToken && this.callbackAesKey) },
  },
  pi: {
    enabled: booleanFromEnv(process.env.PI_AGENT_ENABLED, false),
    provider: process.env.PI_AGENT_PROVIDER ?? 'project-os-gateway',
    modelId: process.env.PI_AGENT_MODEL_ID ?? 'gpt-4o-mini',
    modelName: process.env.PI_AGENT_MODEL_NAME ?? 'Project OS Agent',
    baseUrl: (process.env.PI_AGENT_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: piAgentApiKey,
    maxTokens: numberFromEnv(process.env.PI_AGENT_MAX_TOKENS, 1200),
    timeoutMs: numberFromEnv(process.env.PI_AGENT_TIMEOUT_MS, 15000),
    get available() { return this.enabled && Boolean(this.apiKey) },
  },
  notifications: {
    enabled: booleanFromEnv(process.env.NOTIFICATION_WORKER_ENABLED, true),
    pollIntervalMs: numberFromEnv(process.env.NOTIFICATION_POLL_INTERVAL_MS, 5000),
    maxAttempts: numberFromEnv(process.env.NOTIFICATION_MAX_ATTEMPTS, 3),
  },
  deliverables: {
    storageDir: process.env.DELIVERABLE_STORAGE_DIR ?? path.resolve(process.cwd(), 'server/uploads/deliverables'),
    maxSizeBytes: numberFromEnv(process.env.DELIVERABLE_MAX_SIZE_BYTES, 50 * 1024 * 1024),
  },
}
