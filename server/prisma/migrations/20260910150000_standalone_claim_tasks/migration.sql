CREATE TABLE "ClaimTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "publisherMemberId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "closureCriteria" TEXT,
    "durationDays" INTEGER NOT NULL DEFAULT 1,
    "effortHours" INTEGER NOT NULL DEFAULT 8,
    "status" "TaskExecutionStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "claimedByMemberId" UUID,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "ClaimTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClaimTask_organizationId_archivedAt_claimedByMemberId_createdAt_idx" ON "ClaimTask"("organizationId", "archivedAt", "claimedByMemberId", "createdAt");
CREATE INDEX "ClaimTask_claimedByMemberId_archivedAt_idx" ON "ClaimTask"("claimedByMemberId", "archivedAt");

ALTER TABLE "ClaimTask" ADD CONSTRAINT "ClaimTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTask" ADD CONSTRAINT "ClaimTask_publisherMemberId_fkey" FOREIGN KEY ("publisherMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTask" ADD CONSTRAINT "ClaimTask_claimedByMemberId_fkey" FOREIGN KEY ("claimedByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
