import assert from 'node:assert/strict'
import test from 'node:test'
import { canDecideApprovalStep, expandSequentialApprovers } from '../server/src/approvalRecipientAccess.ts'

test('explicit recipients and CC cannot bypass approval assignment', () => {
  const step = { stage: 'L2', approverMemberIds: ['reviewer'], ccMemberIds: ['cc'] }
  assert.equal(canDecideApprovalStep('reviewer', false, step), true)
  assert.equal(canDecideApprovalStep('cc', true, step), false)
  assert.equal(canDecideApprovalStep('other-admin', true, step), false)
  assert.equal(canDecideApprovalStep('reviewer', false, { ...step, stage: 'ADMIN' }), false)
  assert.equal(canDecideApprovalStep('reviewer', true, { ...step, stage: 'ADMIN' }), true)
  assert.equal(canDecideApprovalStep('cc', true, { ...step, approverMemberIds: [] }), false)
  assert.equal(canDecideApprovalStep('manager', false, { ...step, approverMemberIds: [] }), true)
})

test('multiple approvers become ordered individual levels; CC never becomes an approver', () => {
  const original = [{ stepNo: 1, stage: 'L2', approverMemberIds: ['b', 'a'], ccMemberIds: ['c', 'd'] }, { stepNo: 2, stage: 'ADMIN', approverMemberIds: ['e'], ccMemberIds: [] }]
  const snapshot = expandSequentialApprovers(original)
  assert.deepEqual(snapshot.map((step) => [step.stepNo, step.approverMemberIds]), [[1, ['b']], [2, ['a']], [3, ['e']]])
  assert.deepEqual(snapshot[0].ccMemberIds, ['c', 'd'])
  assert.deepEqual(snapshot[1].ccMemberIds, ['c', 'd'])
  assert.equal(canDecideApprovalStep('a', true, snapshot[0]), false)
  assert.equal(canDecideApprovalStep('a', true, snapshot[1]), true)
  assert.equal(canDecideApprovalStep('c', true, snapshot[0]), false)
  assert.deepEqual(original[0].approverMemberIds, ['b', 'a'])
  assert.deepEqual(expandSequentialApprovers([{ stepNo: 1, approverMemberIds: [] }]), [{ stepNo: 1, approverMemberIds: [] }])
})
