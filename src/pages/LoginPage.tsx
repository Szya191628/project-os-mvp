import { LogIn } from 'lucide-react'
import { beginDingTalkLogin } from '../api'

const errorMessages: Record<string, string> = {
  dingtalk_not_configured: '管理员尚未配置钉钉登录，请联系管理员。',
  dingtalk_authorization_denied: '你已取消钉钉授权。',
  dingtalk_invalid_callback: '钉钉登录回调信息不完整，请重试。',
  dingtalk_invalid_state: '登录状态已失效，请重新发起登录。',
  dingtalk_corp_id_mismatch: '当前钉钉账号不属于已配置的企业。',
  member_not_mapped: '钉钉账号尚未绑定 Project OS 成员，请联系 L1 管理员。',
  dingtalk_login_failed: '钉钉登录失败，请稍后重试。',
  api_unavailable: '项目服务暂时不可用，请先启动后端服务后重试。',
}

export function LoginPage({ error }: { error?: string | null }) {
  const message = error ? errorMessages[error] ?? '登录失败，请稍后重试。' : null
  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-mark">P</div>
      <p className="login-eyebrow">PROJECT OS</p>
      <h1 id="login-title">感知起源科技</h1>
      <p className="login-subtitle">企业项目中枢</p>
      {message && <p className="login-error" role="alert">{message}</p>}
      <button className="button button-primary login-button" type="button" onClick={beginDingTalkLogin}><LogIn size={18} />钉钉一键登录</button>
      <p className="login-hint">请使用企业钉钉账号登录</p>
    </section>
  </main>
}
