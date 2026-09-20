-- Completion is gated by a completed DingTalk approval. Keep the legacy
-- column pending until the approval callback/worker marks the task complete.
ALTER TABLE "TaskExecution"
ALTER COLUMN "completionApprovalStatus" SET DEFAULT 'PENDING';

UPDATE "TaskExecution"
SET "completionApprovalStatus" = 'PENDING'
WHERE "status" NOT IN ('COMPLETED', 'EARLY_FINISHED', 'ON_TIME_FINISHED', 'OVERDUE_FINISHED');

-- Approval-driven successor auto-start is the default product behavior.
ALTER TABLE "Project"
ALTER COLUMN "approvalAutoStart" SET DEFAULT true;

UPDATE "Project"
SET "approvalAutoStart" = true
WHERE "approvalAutoStart" = false;
