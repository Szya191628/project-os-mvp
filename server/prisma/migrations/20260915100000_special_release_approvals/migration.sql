ALTER TABLE "TaskExecution"
ADD COLUMN "specialRelease" JSONB;

ALTER TABLE "TaskApproval"
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'DELIVERY';

CREATE INDEX "TaskApproval_taskId_purpose_status_idx"
ON "TaskApproval"("taskId", "purpose", "status");
