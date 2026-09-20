CREATE TABLE "DingTalkApiUsage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DingTalkApiUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DingTalkApiUsage_organizationId_periodStart_key" ON "DingTalkApiUsage"("organizationId", "periodStart");
CREATE INDEX "DingTalkApiUsage_organizationId_periodStart_idx" ON "DingTalkApiUsage"("organizationId", "periodStart");

ALTER TABLE "DingTalkApiUsage" ADD CONSTRAINT "DingTalkApiUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
