-- Folders: the level between a space and a board.
--
-- monday.com's hierarchy is Workspace -> Folder -> Sub-folder -> Board, and the
-- first cut of this model left the folder out. The client's own use is a folder
-- per department -- PRODUCTION, QUALITY CONTROL, SCM -- with that department's
-- boards inside, and sub-folders under those for a team or a project.
--
-- ## Nesting
--
-- A folder's parent is a folder in the same space, which the composite foreign
-- key enforces rather than the code remembering to. `depth` is stored because
-- every read that bounds nesting would otherwise climb the tree to find out how
-- deep it already is.
--
-- The ceiling (`MAX_FOLDER_DEPTH`, ten) is the cheap half of the protection and
-- lives in the service. The half that matters is also there: a folder may never
-- be moved inside one of its own descendants. That is a loop rather than a
-- depth, and a loop makes a sidebar's own render run until the tab is killed.
--
-- ## boards.folder_id is nullable
--
-- monday.com lets a board sit in a workspace with no folder, and every board
-- made before this migration is exactly that. NO ACTION on the foreign key for
-- the reason ADR-204 records: SET NULL over a composite key would null
-- tenant_id too, and that column is required.
--
-- Written by hand like the migrations before it: `prisma migrate diff` carries
-- pre-existing drift from two migrations edited after they were applied.

ALTER TABLE "boards" ADD COLUMN     "folder_id" UUID;

CREATE TABLE "board_folders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "parent_folder_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "name" VARCHAR(200) NOT NULL,
    "tone" VARCHAR(20) NOT NULL DEFAULT 'grey',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "board_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "board_folders_tenant_id_space_id_archived_at_idx" ON "board_folders"("tenant_id", "space_id", "archived_at");
CREATE INDEX "board_folders_tenant_id_parent_folder_id_idx" ON "board_folders"("tenant_id", "parent_folder_id");
CREATE UNIQUE INDEX "board_folders_tenant_id_id_key" ON "board_folders"("tenant_id", "id");

ALTER TABLE "boards" ADD CONSTRAINT "boards_tenant_id_folder_id_fkey" FOREIGN KEY ("tenant_id", "folder_id") REFERENCES "board_folders"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_tenant_id_space_id_fkey" FOREIGN KEY ("tenant_id", "space_id") REFERENCES "spaces"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_tenant_id_parent_folder_id_fkey" FOREIGN KEY ("tenant_id", "parent_folder_id") REFERENCES "board_folders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, written by hand as Prisma does not generate it. Same shape
-- as every other tenant-owned table; FORCE as well as ENABLE because the
-- application connects as the owner, which bypasses RLS otherwise.

ALTER TABLE "board_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_folders" FORCE ROW LEVEL SECURITY;

CREATE POLICY "board_folders_tenant_isolation" ON "board_folders"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );
