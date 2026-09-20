ALTER TABLE "ApprovalPolicyStep"
ADD COLUMN "approverMemberIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "ccMemberIds" JSONB NOT NULL DEFAULT '[]'::jsonb;
