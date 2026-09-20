-- 审批包关联表（文档 §5.2）：一次完成审批关联多个交付物。
CREATE TABLE "TaskApprovalDeliverable" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "deliverableId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskApprovalDeliverable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskApprovalDeliverable_approvalId_deliverableId_key"
ON "TaskApprovalDeliverable"("approvalId", "deliverableId");
CREATE INDEX "TaskApprovalDeliverable_deliverableId_idx" ON "TaskApprovalDeliverable"("deliverableId");

ALTER TABLE "TaskApprovalDeliverable" ADD CONSTRAINT "TaskApprovalDeliverable_approvalId_fkey"
FOREIGN KEY ("approvalId") REFERENCES "TaskApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskApprovalDeliverable" ADD CONSTRAINT "TaskApprovalDeliverable_deliverableId_fkey"
FOREIGN KEY ("deliverableId") REFERENCES "TaskDeliverable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
