import assert from 'node:assert/strict'
import test from 'node:test'
import { getFlowCanvasMetrics, getFlowCanvasPanScroll, getFlowNodePositionFromDrag, getFlowNodePositionFromPointer } from '../src/workflow/canvas.ts'

test('流程画布支持向上和向左扩展，并保留可视原点', () => {
  const metrics = getFlowCanvasMetrics([{ position: { x: -240, y: -180 } }], 184, 88, { width: 0, height: 0, left: 0, top: 0 })
  assert.equal(metrics.origin.x, 240)
  assert.equal(metrics.origin.y, 180)
  assert.ok(metrics.width >= 1080 + 240)
  assert.ok(metrics.height >= 560 + 180)
  assert.equal(-240 + metrics.origin.x, 0)
  assert.equal(-180 + metrics.origin.y, 0)
})

test('节点拖动坐标允许越过顶部和左侧边界', () => {
  const position = getFlowNodePositionFromPointer({ pointer: { x: -24, y: -36 }, canvasRect: { left: 0, top: 0 }, dragOffset: { x: 12, y: 18 }, origin: { x: 0, y: 0 } })
  assert.deepEqual(position, { x: -36, y: -54 })
})

test('全屏拖动时画布原点和滚动同步变化不会让节点跳走', () => {
  const position = getFlowNodePositionFromDrag({
    startPosition: { x: 100, y: 200 },
    pointerStart: { x: 110, y: 220 },
    pointer: { x: 130, y: 260 },
    startScroll: { x: 0, y: 0 },
    scroll: { x: 1200, y: 800 },
    startOrigin: { x: 0, y: 0 },
    origin: { x: 1200, y: 800 },
  })
  assert.deepEqual(position, { x: 120, y: 240 })
})

test('画布平移使用相邻指针增量，扩展后不会重复累计拖动起点', () => {
  const scroll = getFlowCanvasPanScroll({ scroll: { x: 1200, y: 900 }, previousPointer: { x: 328, y: 209 }, pointer: { x: 348, y: 221 } })
  assert.deepEqual(scroll, { x: 1180, y: 888 })
})
