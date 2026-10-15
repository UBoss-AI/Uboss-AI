-- A space belongs to a department, or to the whole company — CR-04.
--
-- The client's requirement is that somebody sees their own department's RIS and not everybody's.
-- The department sits on the space rather than on each board, because a space is what a person
-- opens; putting it on the board would let one space hold two departments' work, which is the
-- thing being separated.
--
-- Nullable, and the null means something: a space with no department is the whole company's.
-- Every space that exists today becomes one, which is the only honest default — inferring a
-- department for work somebody else organised would be guessing.
--
-- `ON DELETE RESTRICT`, as every other department relation in this schema is: a department with
-- spaces in it is not an empty department, and deleting it would either destroy work or leave it
-- pointing at nothing. The spaces are moved first, which is a decision somebody makes.
--
-- No RLS policy is added here: `spaces` already carries one on `tenant_id`, and this column adds
-- no new way to reach a row.

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "department_id" UUID;

-- CreateIndex
CREATE INDEX "spaces_tenant_id_department_id_idx" ON "spaces"("tenant_id", "department_id");

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
