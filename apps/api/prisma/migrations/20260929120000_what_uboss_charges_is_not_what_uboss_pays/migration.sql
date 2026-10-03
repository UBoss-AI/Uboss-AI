-- UBoss buys AI and sells it. Until now it did neither: a company's wallet was debited the exact
-- amount the provider charged, so every call was sold at cost and the product had no gross margin
-- at all. `pricing_versions` was the only price in the system, and it is the *buy* price.
--
-- This is the sell side. One multiplier over the provider's own price, because a per-model sell
-- price would be a second pricing table to keep in step with the first, and the first already
-- moves whenever a provider changes a rate or the rupee does.
--
-- 5.0 by the client's decision: a company pays five times what the call costs UBoss, which is an
-- 80% gross margin on AI. It is a setting rather than a constant so changing it is a Master
-- Console action that lands in the security trail, not a deployment.
--
-- **Not locked.** A locked setting is a product rule; what to charge is a commercial decision and
-- the people who make it are the ones with the Commercial role.
INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'commercial.ai_sell_multiplier', '5'::jsonb,
   'What a company pays for AI, as a multiple of what the call costs UBoss. 1 would sell every '
     || 'call at cost and earn nothing; 5 is an 80% gross margin. The provider''s own price is '
     || 'never shown to a company and never leaves the platform plane — a company sees only what '
     || 'it is charged.',
   'Commercial', false, NOW(), NOW(), 1)
ON CONFLICT ("key") DO NOTHING;
