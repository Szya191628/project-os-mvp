-- Prevent the same DingTalk openId from being linked to multiple members.
CREATE UNIQUE INDEX "ExternalIdentity_provider_corpId_openId_key"
ON "ExternalIdentity"("provider", "corpId", "openId");
