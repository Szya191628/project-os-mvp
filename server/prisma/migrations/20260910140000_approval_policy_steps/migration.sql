CREATE TYPE "ApprovalStepStage" AS ENUM ('L2', 'ADMIN');
CREATE TYPE "ApprovalStepMode" AS ENUM ('ANY', 'ALL');

CREATE TABLE "ApprovalPolicy" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApprovalPolicyStep" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "stage" "ApprovalStepStage" NOT NULL,
    "mode" "ApprovalStepMode" NOT NULL DEFAULT 'ANY',
    "minApprovals" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalPolicyStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskApprovalStep" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "stage" "ApprovalStepStage" NOT NULL,
    "mode" "ApprovalStepMode" NOT NULL DEFAULT 'ANY',
    "minApprovals" INTEGER NOT NULL DEFAULT 1,
    "processInstanceId" TEXT NOT NULL,
    "approverUserIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskApprovalStep_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TaskApproval" ADD COLUMN "policyId" UUID;
ALTER TABLE "TaskApproval" ADD COLUMN "policySnapshot" JSONB;
ALTER TABLE "TaskApproval" ADD COLUMN "currentStepNo" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "ApprovalPolicy_projectId_key" ON "ApprovalPolicy"("projectId");
CREATE UNIQUE INDEX "ApprovalPolicyStep_policyId_stepNo_key" ON "ApprovalPolicyStep"("policyId", "stepNo");
CREATE INDEX "ApprovalPolicyStep_policyId_stepNo_idx" ON "ApprovalPolicyStep"("policyId", "stepNo");
CREATE UNIQUE INDEX "TaskApprovalStep_processInstanceId_key" ON "TaskApprovalStep"("processInstanceId");
CREATE UNIQUE INDEX "TaskApprovalStep_approvalId_stepNo_key" ON "TaskApprovalStep"("approvalId", "stepNo");
CREATE INDEX "TaskApprovalStep_approvalId_stepNo_idx" ON "TaskApprovalStep"("approvalId", "stepNo");
CREATE INDEX "TaskApprovalStep_status_updatedAt_idx" ON "TaskApprovalStep"("status", "updatedAt");

ALTER TABLE "ApprovalPolicy" ADD CONSTRAINT "ApprovalPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApprovalPolicyStep" ADD CONSTRAINT "ApprovalPolicyStep_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ApprovalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskApproval" ADD CONSTRAINT "TaskApproval_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ApprovalPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskApprovalStep" ADD CONSTRAINT "TaskApprovalStep_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "TaskApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
