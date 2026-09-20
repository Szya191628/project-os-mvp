-- CreateTable
CREATE TABLE "TaskAssignee" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "assignedById" UUID,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRoleGrant" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "roleCode" TEXT NOT NULL DEFAULT 'L2',
    "grantedById" UUID NOT NULL,
    "parentGrantId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskAssignee_taskId_removedAt_idx" ON "TaskAssignee"("taskId", "removedAt");

-- CreateIndex
CREATE INDEX "TaskAssignee_memberId_removedAt_idx" ON "TaskAssignee"("memberId", "removedAt");

-- CreateIndex
CREATE INDEX "ProjectRoleGrant_projectId_memberId_roleCode_revokedAt_idx" ON "ProjectRoleGrant"("projectId", "memberId", "roleCode", "revokedAt");

-- CreateIndex
CREATE INDEX "ProjectRoleGrant_projectId_revokedAt_idx" ON "ProjectRoleGrant"("projectId", "revokedAt");

-- CreateIndex
CREATE INDEX "ProjectRoleGrant_grantedById_createdAt_idx" ON "ProjectRoleGrant"("grantedById", "createdAt");

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleGrant" ADD CONSTRAINT "ProjectRoleGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleGrant" ADD CONSTRAINT "ProjectRoleGrant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleGrant" ADD CONSTRAINT "ProjectRoleGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleGrant" ADD CONSTRAINT "ProjectRoleGrant_parentGrantId_fkey" FOREIGN KEY ("parentGrantId") REFERENCES "ProjectRoleGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
