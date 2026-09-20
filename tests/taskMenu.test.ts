import assert from 'node:assert/strict'
import test from 'node:test'
import { getTaskMenuActions } from '../src/workflow/taskMenu.ts'

test('L3 任务负责人可以看到交付和特殊放行，不能看到编辑', () => {
  assert.deepEqual(getTaskMenuActions({ hasTaskId: true, isCompleted: false, isNotStarted: false, hasBlockingPredecessors: true, hasPendingApproval: false, hasSpecialRelease: false, canDirectStart: false, isL3: true, isOwnTask: true, canViewProgress: true, canSubmitApproval: true, canEdit: false }), ['view', 'submit-approval', 'special-release', 'approval-history'])
})

test('L3 查看他人任务只保留查看任务和查看进度', () => {
  assert.deepEqual(getTaskMenuActions({ hasTaskId: true, isCompleted: false, isNotStarted: false, hasBlockingPredecessors: true, hasPendingApproval: false, hasSpecialRelease: false, canDirectStart: false, isL3: true, isOwnTask: false, canViewProgress: true, canSubmitApproval: false, canEdit: false }), ['view', 'view-progress'])
})

test('L1/L2 管理他人任务只显示查看进度和编辑任务', () => {
  assert.deepEqual(getTaskMenuActions({ hasTaskId: true, isCompleted: true, isNotStarted: false, hasBlockingPredecessors: false, hasPendingApproval: false, hasSpecialRelease: false, canDirectStart: false, isL3: false, isOwnTask: false, canViewProgress: true, canSubmitApproval: true, canEdit: true }), ['view-progress', 'edit'])
})

test('管理员同时是负责人时拥有全部适用功能', () => {
  assert.deepEqual(getTaskMenuActions({ hasTaskId: true, isCompleted: false, isNotStarted: false, hasBlockingPredecessors: true, hasPendingApproval: false, hasSpecialRelease: false, canDirectStart: false, isL3: false, isOwnTask: true, canViewProgress: true, canSubmitApproval: true, canEdit: true }), ['view', 'view-progress', 'submit-approval', 'special-release', 'edit', 'approval-history'])
})

test('L1/L2 可以对未开始任务直接开启', () => {
  assert.deepEqual(getTaskMenuActions({ hasTaskId: true, isCompleted: false, isNotStarted: true, hasBlockingPredecessors: true, hasPendingApproval: false, hasSpecialRelease: false, canDirectStart: true, isL3: false, isOwnTask: false, canViewProgress: true, canSubmitApproval: true, canEdit: true }), ['view-progress', 'direct-start', 'edit'])
})
