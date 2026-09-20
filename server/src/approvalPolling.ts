export function isApprovalPollDue(nowMs: number, lastRunAtMs: number | null, intervalMs: number) {
  if (lastRunAtMs === null) return true
  return nowMs - lastRunAtMs >= Math.max(1_000, intervalMs)
}
