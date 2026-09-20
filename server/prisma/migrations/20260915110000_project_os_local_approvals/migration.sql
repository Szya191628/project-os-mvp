ALTER TABLE "TaskApproval"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DINGTALK';

CREATE INDEX "TaskApproval_source_status_updatedAt_idx"
ON "TaskApproval"("source", "status", "updatedAt");
