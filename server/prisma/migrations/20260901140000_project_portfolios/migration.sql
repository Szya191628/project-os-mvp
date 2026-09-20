CREATE TABLE "ProjectPortfolio" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerMemberId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectPortfolio_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Project" ADD COLUMN "portfolioId" UUID;

CREATE UNIQUE INDEX "ProjectPortfolio_organizationId_code_key" ON "ProjectPortfolio"("organizationId", "code");
CREATE INDEX "ProjectPortfolio_organizationId_archivedAt_updatedAt_idx" ON "ProjectPortfolio"("organizationId", "archivedAt", "updatedAt");
CREATE INDEX "Project_portfolioId_archivedAt_idx" ON "Project"("portfolioId", "archivedAt");

ALTER TABLE "ProjectPortfolio" ADD CONSTRAINT "ProjectPortfolio_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectPortfolio" ADD CONSTRAINT "ProjectPortfolio_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "ProjectPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
