CREATE TABLE "MemberDepartment" (
    "memberId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDepartment_pkey" PRIMARY KEY ("memberId", "departmentId")
);

CREATE INDEX "MemberDepartment_departmentId_idx" ON "MemberDepartment"("departmentId");

ALTER TABLE "MemberDepartment" ADD CONSTRAINT "MemberDepartment_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemberDepartment" ADD CONSTRAINT "MemberDepartment_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "MemberDepartment" ("memberId", "departmentId")
SELECT "id", "departmentId"
FROM "Member"
WHERE "departmentId" IS NOT NULL
ON CONFLICT ("memberId", "departmentId") DO NOTHING;
