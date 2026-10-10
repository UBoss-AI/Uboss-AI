-- Task & Tracker -- the board model.
--
-- Seven tables: a Space holds boards, a board holds groups and columns, a group
-- holds items, an item holds subitems, and a cell is one item's value in one
-- column. Modelled on monday.com, which is what the client asked for.
--
-- ## Why the cell is a row and not a column
--
-- A board is an empty table until somebody chooses its columns, and the whole
-- point is that the same structure becomes a hiring pipeline or a bug list
-- depending on which columns sit on it. Columns as database columns would make
-- every new kind a migration and every board a different table. So a column is a
-- row, a cell is a row, and the value is JSONB whose shape the column's kind
-- owns. Thirty kinds is then a list, not thirty tables.
--
-- Sparse on purpose: five hundred items and twenty columns is not ten thousand
-- cells, it is however many somebody filled. An empty cell is the absence of a
-- row rather than a row holding nothing.
--
-- ## Why every child carries tenant_id and points at (tenant_id, id)
--
-- ADR-064. A composite foreign key cannot reference a parent in another company,
-- so cross-tenant leakage is refused by the database rather than by remembering
-- to filter. The row-level security below is the second lock, not the only one.
--
-- ## Written by hand
--
-- `prisma migrate diff` carries pre-existing drift from two migrations that were
-- edited after they were applied -- two DROP INDEX, three ALTER COLUMN DROP
-- DEFAULT and a set of constraint renames, none of which belong to this work.
-- Policy rule 6 keeps a destructive step from riding along with an additive one.

-- CreateTable
CREATE TABLE "spaces" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "tone" VARCHAR(20) NOT NULL DEFAULT 'blue',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "kind" VARCHAR(20) NOT NULL DEFAULT 'Main',
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'Member',
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_columns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 160,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "tone" VARCHAR(20) NOT NULL DEFAULT 'grey',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "parent_item_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "name" VARCHAR(500) NOT NULL,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "objective_id" UUID,
    "human_task_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_cell_values" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "column_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_cell_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spaces_tenant_id_archived_at_idx" ON "spaces"("tenant_id", "archived_at");
-- CreateIndex
CREATE UNIQUE INDEX "spaces_tenant_id_id_key" ON "spaces"("tenant_id", "id");
-- CreateIndex
CREATE INDEX "boards_tenant_id_space_id_archived_at_idx" ON "boards"("tenant_id", "space_id", "archived_at");
-- CreateIndex
CREATE UNIQUE INDEX "boards_tenant_id_id_key" ON "boards"("tenant_id", "id");
-- CreateIndex
CREATE INDEX "board_members_tenant_id_user_id_idx" ON "board_members"("tenant_id", "user_id");
-- CreateIndex
CREATE UNIQUE INDEX "one_membership_per_person_per_board" ON "board_members"("board_id", "user_id");
-- CreateIndex
CREATE INDEX "board_columns_tenant_id_board_id_archived_at_idx" ON "board_columns"("tenant_id", "board_id", "archived_at");
-- CreateIndex
CREATE UNIQUE INDEX "board_columns_tenant_id_id_key" ON "board_columns"("tenant_id", "id");
-- CreateIndex
CREATE INDEX "board_groups_tenant_id_board_id_archived_at_idx" ON "board_groups"("tenant_id", "board_id", "archived_at");
-- CreateIndex
CREATE UNIQUE INDEX "board_groups_tenant_id_id_key" ON "board_groups"("tenant_id", "id");
-- CreateIndex
CREATE INDEX "board_items_tenant_id_board_id_group_id_archived_at_idx" ON "board_items"("tenant_id", "board_id", "group_id", "archived_at");
-- CreateIndex
CREATE INDEX "board_items_tenant_id_parent_item_id_idx" ON "board_items"("tenant_id", "parent_item_id");
-- CreateIndex
CREATE UNIQUE INDEX "board_items_tenant_id_id_key" ON "board_items"("tenant_id", "id");
-- CreateIndex
CREATE INDEX "board_cell_values_tenant_id_column_id_idx" ON "board_cell_values"("tenant_id", "column_id");
-- CreateIndex
CREATE UNIQUE INDEX "one_value_per_cell" ON "board_cell_values"("item_id", "column_id");

ALTER TABLE "spaces" ADD CONSTRAINT "spaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "boards" ADD CONSTRAINT "boards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "boards" ADD CONSTRAINT "boards_tenant_id_space_id_fkey" FOREIGN KEY ("tenant_id", "space_id") REFERENCES "spaces"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_tenant_id_board_id_fkey" FOREIGN KEY ("tenant_id", "board_id") REFERENCES "boards"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_tenant_id_board_id_fkey" FOREIGN KEY ("tenant_id", "board_id") REFERENCES "boards"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_groups" ADD CONSTRAINT "board_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_groups" ADD CONSTRAINT "board_groups_tenant_id_board_id_fkey" FOREIGN KEY ("tenant_id", "board_id") REFERENCES "boards"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_tenant_id_board_id_fkey" FOREIGN KEY ("tenant_id", "board_id") REFERENCES "boards"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "board_groups"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "board_items" ADD CONSTRAINT "board_items_tenant_id_parent_item_id_fkey" FOREIGN KEY ("tenant_id", "parent_item_id") REFERENCES "board_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_cell_values" ADD CONSTRAINT "board_cell_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_cell_values" ADD CONSTRAINT "board_cell_values_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "board_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_cell_values" ADD CONSTRAINT "board_cell_values_tenant_id_column_id_fkey" FOREIGN KEY ("tenant_id", "column_id") REFERENCES "board_columns"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_cell_values" ADD CONSTRAINT "board_cell_values_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Prisma does not generate these; every tenant-owned table needs its policy
-- written by hand or it is readable across companies the moment a query runs
-- outside a tenant transaction. The shape is the one every other tenant table
-- uses: the row's company must match the session's, or the session must be an
-- explicit platform operation.
--
-- FORCE as well as ENABLE, because the owner role bypasses RLS otherwise -- and
-- the application connects as the owner.
-- ---------------------------------------------------------------------------

ALTER TABLE "spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spaces" FORCE ROW LEVEL SECURITY;

CREATE POLICY "spaces_tenant_isolation" ON "spaces"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "boards" FORCE ROW LEVEL SECURITY;

CREATE POLICY "boards_tenant_isolation" ON "boards"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "board_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_members_tenant_isolation" ON "board_members"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "board_columns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_columns" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_columns_tenant_isolation" ON "board_columns"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "board_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_groups" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_groups_tenant_isolation" ON "board_groups"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "board_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_items_tenant_isolation" ON "board_items"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "board_cell_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_cell_values" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_cell_values_tenant_isolation" ON "board_cell_values"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- One default space per company.
--
-- A partial unique index rather than a check in the service: "exactly one" is a
-- claim about the whole table, and a service that reads then writes has a gap
-- between the two where a second request fits. Partial, because the constraint
-- is only about the rows that claim to be the default -- every other space is
-- free to be one of many.
--
-- Prisma cannot express a partial unique index, so it lives here and nowhere
-- else; the schema's `isDefault` carries a comment pointing at it.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "one_default_space_per_company"
  ON "spaces" ("tenant_id")
  WHERE "is_default" AND "archived_at" IS NULL;
