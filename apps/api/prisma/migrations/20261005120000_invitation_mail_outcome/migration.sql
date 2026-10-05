-- What happened to an invitation's activation email, recorded where the inviting company can read it.
--
-- The invitation commits before the mail is attempted, which is correct: a mail failure must not
-- undo an invitation that was properly issued. The cost was that the failure went nowhere. It was
-- logged inside the API container and the administrator was shown success either way, so
-- "invitations are not arriving" had no answer anywhere in the product.
--
-- Three columns, all nullable: every invitation issued before this migration has no recorded
-- outcome, and NULL says exactly that rather than guessing one.
--
-- Hand-written. `prisma migrate diff` also emits pre-existing drift on this database — index drops
-- on agent_builder_test_runs and sso_auth_requests, and DEFAULT removals on three updated_at
-- columns — none of which belong to this change. Letting a destructive statement ride along with
-- an additive one is how an unrelated index disappears in production.

ALTER TABLE "invitations"
  ADD COLUMN "mail_state" VARCHAR(16),
  ADD COLUMN "mail_error" VARCHAR(500),
  ADD COLUMN "mail_attempted_at" TIMESTAMPTZ(6);
