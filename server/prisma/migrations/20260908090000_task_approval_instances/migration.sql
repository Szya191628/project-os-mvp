-- 钉钉 OA 审批集成：任务审批实例表 + 项目级"审批通过后自动开始后续任务"开关。
CREATE TABLE "TaskApproval" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "processInstanceId" TEXT NOT NULL,
    "processCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "autoCompleteStatus" TEXT,
    "submitterMemberId" UUID,
    "submitterName" TEXT,
    "submitterDingUserId" TEXT,
    "formValues" JSONB,
    "approvalFileId" TEXT,
    "approvalSpaceId" TEXT,
    "approvalFileName" TEXT,
    "approvalMimeType" TEXT,
    "approvalSizeBytes" BIGINT,
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskApproval_processInstanceId_key" ON "TaskApproval"("processInstanceId");
CREATE INDEX "TaskApproval_taskId_createdAt_idx" ON "TaskApproval"("taskId", "createdAt");
CREATE INDEX "TaskApproval_status_updatedAt_idx" ON "TaskApproval"("status", "updatedAt");

ALTER TABLE "TaskApproval" ADD CONSTRAINT "TaskApproval_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Project" ADD COLUMN "approvalAutoStart" BOOLEAN NOT NULL DEFAULT false;
