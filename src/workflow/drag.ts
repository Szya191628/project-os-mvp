import type { WorkflowPosition } from '../types'

export function hasExceededDragThreshold(start: WorkflowPosition, current: WorkflowPosition, threshold = 4) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold
}
