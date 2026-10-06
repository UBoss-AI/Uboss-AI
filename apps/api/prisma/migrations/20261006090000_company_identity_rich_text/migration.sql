-- The company Vision and Mission hold formatted text, so they stop being a thousand characters.
--
-- The client asked for both to be written in their own fonts, sizes, colours and lists. That is
-- markup, and markup is mostly markup: one coloured, sized span costs about fifty characters
-- before a word is typed, so a Vision of three formatted sentences would not have fitted in the
-- old column. The limit a person can perceive is enforced on the text with the tags removed, in
-- the DTO, which is the only place that limit means anything.
--
-- Widening only. VARCHAR(1000) to TEXT keeps every existing value exactly as it is, and Postgres
-- rewrites nothing: the two types share a representation.
--
-- Hand-written, because `prisma migrate diff` also emits pre-existing drift on this database --
-- index drops on agent_builder_test_runs and sso_auth_requests, and DEFAULT removals on three
-- updated_at columns -- none of which belong to this change.

ALTER TABLE "tenants"
  ALTER COLUMN "vision" SET DATA TYPE TEXT,
  ALTER COLUMN "mission" SET DATA TYPE TEXT;
