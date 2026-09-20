-- Distinguish a progress/phase delivery from the final completion request.
-- Existing approvals keep the historical behavior: approval means completion.
ALTER TABLE "TaskApproval"
ADD COLUMN "deliveryType" TEXT NOT NULL DEFAULT 'FINAL';
