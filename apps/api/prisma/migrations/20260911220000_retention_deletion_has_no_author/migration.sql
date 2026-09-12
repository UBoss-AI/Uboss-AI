-- ===========================================================================
-- A retention deletion has no author — Prompt 35
-- ===========================================================================
--
-- `file_deletion_is_explained` required `deleted_by_user_id` alongside `deleted_at` and
-- `deleted_reason`, on the reasoning that a deletion should be attributed in all directions. That
-- is right for a deletion somebody asked for and **wrong for the retention sweep**, which is the
-- policy acting rather than a person. The sweep had two ways out and both were worse than fixing
-- the constraint:
--
--   * write the id of whoever happened to trigger the sweep — false attribution, and the exact
--     thing an access review must be able to trust;
--   * write a sentinel user id — a fake person in a foreign key.
--
-- So attribution is now optional and **the explanation is not**. A NULL author means UBoss itself
-- deleted the file, and `deleted_reason` says under what policy. The audit row carries the rest.
ALTER TABLE "files" DROP CONSTRAINT "file_deletion_is_explained";

ALTER TABLE "files"
  ADD CONSTRAINT "file_deletion_is_explained"
  CHECK (
    ("deleted_at" IS NULL AND "deleted_reason" IS NULL AND "deleted_by_user_id" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "deleted_reason" IS NOT NULL)
  );
