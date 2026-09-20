export type FlowCanvasPoint = { x: number; y: number }
export type FlowCanvasExpansion = { width: number; height: number; left: number; top: number }
export type FlowCanvasMetrics = { width: number; height: number; origin: FlowCanvasPoint }

type PositionedNode = { position: FlowCanvasPoint }

export function getFlowCanvasMetrics(nodes: readonly PositionedNode[], nodeWidth: number, nodeHeight: number, expansion: FlowCanvasExpansion): FlowCanvasMetrics {
  const minX = nodes.reduce((min, node) => Math.min(min, node.position.x), 0)
  const minY = nodes.reduce((min, node) => Math.min(min, node.position.y), 0)
  const maxX = nodes.reduce((max, node) => Math.max(max, node.position.x + nodeWidth), 960)
  const maxY = nodes.reduce((max, node) => Math.max(max, node.position.y + nodeHeight), 440)
  const origin = { x: expansion.left + Math.max(0, -minX), y: expansion.top + Math.max(0, -minY) }
  return {
    width: Math.max(1080, maxX + origin.x + 120 + expansion.width),
    height: Math.max(560, maxY + origin.y + 120 + expansion.height),
    origin,
  }
}

export function getFlowNodePositionFromPointer(input: { pointer: FlowCanvasPoint; canvasRect: Pick<DOMRect, 'left' | 'top'>; dragOffset: FlowCanvasPoint; origin: FlowCanvasPoint }): FlowCanvasPoint {
  return {
    x: Math.round(input.pointer.x - input.canvasRect.left - input.dragOffset.x - input.origin.x),
    y: Math.round(input.pointer.y - input.canvasRect.top - input.dragOffset.y - input.origin.y),
  }
}

export function getFlowNodePositionFromDrag(input: { startPosition: FlowCanvasPoint; pointerStart: FlowCanvasPoint; pointer: FlowCanvasPoint; startScroll: FlowCanvasPoint; scroll: FlowCanvasPoint; startOrigin: FlowCanvasPoint; origin: FlowCanvasPoint }): FlowCanvasPoint {
  return {
    x: Math.round(input.startPosition.x + (input.pointer.x - input.pointerStart.x) + (input.scroll.x - input.startScroll.x) - (input.origin.x - input.startOrigin.x)),
    y: Math.round(input.startPosition.y + (input.pointer.y - input.pointerStart.y) + (input.scroll.y - input.startScroll.y) - (input.origin.y - input.startOrigin.y)),
  }
}

export function getFlowCanvasPanScroll(input: { scroll: FlowCanvasPoint; previousPointer: FlowCanvasPoint; pointer: FlowCanvasPoint }): FlowCanvasPoint {
  return {
    x: input.scroll.x - (input.pointer.x - input.previousPointer.x),
    y: input.scroll.y - (input.pointer.y - input.previousPointer.y),
  }
}
