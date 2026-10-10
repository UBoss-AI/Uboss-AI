-- The thread on a board item, and the item's own description.
--
-- monday.com calls it an "update", and it is the part of a board that is not a
-- table: a status column says where something is, the thread says why, who asked
-- and what was decided. On a board people actually use, that is where most of
-- the writing happens -- so a board without it is a spreadsheet.
--
-- Replies are the same table with a parent, one level deep. A thread of threads
-- is a forum, and nobody reads those.
--
-- Written by hand like the migration before it: `prisma migrate diff` carries
-- pre-existing drift from two migrations edited after they were applied, and
-- none of it belongs here.

ALTER TABLE "board_items" ADD COLUMN "description" VARCHAR(5000);

CREATE TABLE "board_item_updates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "parent_update_id" UUID,
    "body" VARCHAR(20000) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "edited_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_item_updates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "board_item_updates_tenant_id_item_id_archived_at_idx" ON "board_item_updates"("tenant_id", "item_id", "archived_at");
CREATE UNIQUE INDEX "board_item_updates_tenant_id_id_key" ON "board_item_updates"("tenant_id", "id");

ALTER TABLE "board_item_updates" ADD CONSTRAINT "board_item_updates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_item_updates" ADD CONSTRAINT "board_item_updates_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "board_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_item_updates" ADD CONSTRAINT "board_item_updates_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "board_item_updates" ADD CONSTRAINT "board_item_updates_tenant_id_parent_update_id_fkey" FOREIGN KEY ("tenant_id", "parent_update_id") REFERENCES "board_item_updates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, written by hand as Prisma does not generate it. Same shape
-- as every other tenant-owned table; FORCE as well as ENABLE because the
-- application connects as the owner, which bypasses RLS otherwise.

ALTER TABLE "board_item_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_item_updates" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_item_updates_tenant_isolation" ON "board_item_updates"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );
