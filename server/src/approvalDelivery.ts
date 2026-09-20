export type TaskDeliveryType = 'STAGE' | 'FINAL'
export type TaskApprovalPurpose = 'DELIVERY' | 'BYPASS'

/** 解析同一钉钉 OA 模板里的业务用途；历史审批默认仍是普通交付。 */
export function parseTaskApprovalPurpose(value: string | undefined): TaskApprovalPurpose {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, '') ?? ''
  return /特殊放行|跨节点|放行|bypass/u.test(normalized) ? 'BYPASS' : 'DELIVERY'
}

export function taskApprovalPurposeLabel(purpose: TaskApprovalPurpose) {
  return purpose === 'BYPASS' ? '特殊放行' : '任务交付'
}

/**
 * 解析钉钉 OA 表单中的交付类型。
 * 历史模板没有该字段，缺省按最终交付兼容处理，避免旧审批被误判为阶段交付。
 */
export function parseTaskDeliveryType(value: string | undefined): TaskDeliveryType {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, '') ?? ''
  if (normalized === 'stage' || normalized === 'stagedelivery' || /阶段|中间|过程|补充|阶段性/u.test(normalized)) return 'STAGE'
  return 'FINAL'
}

/** 解析钉钉 OA 的数字/文本进度，统一为 0-100 的整数百分比。 */
export function parseDeliveryProgress(value: string | undefined): number | undefined {
  const normalized = value?.trim().replace(/%/gu, '') ?? ''
  if (!normalized) return undefined
  const progress = Number(normalized)
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) return undefined
  return Math.round(progress)
}

export function completesTaskAfterApproval(deliveryType: TaskDeliveryType) {
  return deliveryType === 'FINAL'
}

export function taskDeliveryTypeLabel(deliveryType: TaskDeliveryType) {
  return deliveryType === 'STAGE' ? '阶段交付' : '最终交付'
}
