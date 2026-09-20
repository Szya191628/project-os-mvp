-- AlterEnum
ALTER TYPE "ExternalIdentityProvider" ADD VALUE 'WECHAT';

-- CreateTable
CREATE TABLE "WechatBindingCode" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WechatBindingCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WechatBindingCode_codeHash_key" ON "WechatBindingCode"("codeHash");

-- CreateIndex
CREATE INDEX "WechatBindingCode_memberId_createdAt_idx" ON "WechatBindingCode"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "WechatBindingCode_expiresAt_idx" ON "WechatBindingCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "WechatBindingCode" ADD CONSTRAINT "WechatBindingCode_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ClaimTask_organizationId_archivedAt_claimedByMemberId_createdAt" RENAME TO "ClaimTask_organizationId_archivedAt_claimedByMemberId_creat_idx";
