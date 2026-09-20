import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskApprovalPurpose } from '../server/src/approvalDelivery.ts'
import { isSpecialReleaseForVersion, parseSpecialRelease } from '../server/src/taskRelease.ts'

const release = {
  workflowVersionId: 'version-1',
  targetNodeId: 'node-2',
  predecessorTaskIds: ['task-1'],
  predecessors: [{ taskId: 'task-1', nodeId: 'node-1', wbs: '1.1', name: '前置任务', status: 'NOT_STARTED' }],
  reason: '需要先行开展联调',
}

test('特殊放行只对匹配的已发布流程版本生效', () => {
  assert.deepEqual(isSpecialReleaseForVersion(release, 'version-1'), release)
  assert.equal(isSpecialReleaseForVersion(release, 'version-2'), null)
  assert.equal(parseSpecialRelease({ ...release, reason: '' }), null)
})

test('钉钉交付类型能识别特殊放行并兼容旧值', () => {
  assert.equal(parseTaskApprovalPurpose('特殊放行'), 'BYPASS')
  assert.equal(parseTaskApprovalPurpose('跨节点推进'), 'BYPASS')
  assert.equal(parseTaskApprovalPurpose('最终交付'), 'DELIVERY')
  assert.equal(parseTaskApprovalPurpose(undefined), 'DELIVERY')
})
