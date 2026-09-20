/** Callers must first verify active membership and project management access. */
export function expandSequentialApprovers<T extends { stepNo: number; approverMemberIds: string[] }>(steps: T[]): T[] {
  return steps.flatMap((step) => step.approverMemberIds.length
    ? step.approverMemberIds.map((memberId) => ({ ...step, approverMemberIds: [memberId] }))
    : [{ ...step }]).map((step, index) => ({ ...step, stepNo: index + 1 }))
}

export function canDecideApprovalStep(memberId: string, isL1: boolean, step: { stage?: string; approverMemberIds: string[]; ccMemberIds: string[] }) {
  if (step.stage === 'ADMIN' && !isL1) return false
  if (step.approverMemberIds.length) return step.approverMemberIds.includes(memberId)
  return !step.ccMemberIds.includes(memberId)
}
