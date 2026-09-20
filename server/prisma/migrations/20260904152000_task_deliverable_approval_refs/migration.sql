-- Keep the DingTalk approval instance and attachment identity next to the
-- Project OS deliverable so a predecessor file can be fetched on demand.
ALTER TABLE "TaskDeliverable" ADD COLUMN "approvalProcessInstanceId" TEXT;
ALTER TABLE "TaskDeliverable" ADD COLUMN "approvalProcessCode" TEXT;
ALTER TABLE "TaskDeliverable" ADD COLUMN "approvalFileId" TEXT;
ALTER TABLE "TaskDeliverable" ADD COLUMN "approvalSpaceId" TEXT;

CREATE INDEX "TaskDeliverable_approvalProcessInstanceId_approvalFileId_idx"
ON "TaskDeliverable"("approvalProcessInstanceId", "approvalFileId");
