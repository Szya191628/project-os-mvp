ALTER TABLE "TaskExecution"
ADD COLUMN "completionApprovalStatus" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "completionConfirmedAt" DATE;
