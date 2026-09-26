-- Every department gets a Workshop: a conversation the department itself owns.
--
-- A third kind beside Direct and Group. It is not a Group with a good name: a group's membership is
-- a list somebody typed, and a workshop's membership is "who works in this department" -- which
-- changes when somebody moves, and must change with it rather than being re-typed.

ALTER TABLE "chat_conversations"
  ADD COLUMN IF NOT EXISTS "department_id" UUID;

-- The department this workshop belongs to. `NoAction` rather than `Cascade`: a department is
-- archived rather than deleted, and a conversation is a record of what people said.
ALTER TABLE "chat_conversations"
  DROP CONSTRAINT IF EXISTS "chat_conversations_department_fk";
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "chat_conversations_department_fk"
  FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- One workshop per department, and no more. Partial, so it constrains only the new kind.
DROP INDEX IF EXISTS "one_workshop_per_department";
CREATE UNIQUE INDEX "one_workshop_per_department"
  ON "chat_conversations" ("tenant_id", "department_id")
  WHERE "kind" = 'DepartmentWorkshop';

-- The vocabulary learns the new word.
ALTER TABLE "chat_conversations" DROP CONSTRAINT IF EXISTS "conversation_kind_is_known";
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "conversation_kind_is_known"
  CHECK (kind IN ('Direct', 'Group', 'DepartmentWorkshop'));

-- And the shape rule. A workshop carries a department and a title and never a direct key; the two
-- existing shapes are unchanged, so no existing row can fail this.
ALTER TABLE "chat_conversations" DROP CONSTRAINT IF EXISTS "conversation_shape_matches_its_kind";
ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "conversation_shape_matches_its_kind"
  CHECK (
    COALESCE(
      (kind = 'Direct' AND direct_key IS NOT NULL AND title IS NULL AND department_id IS NULL)
      OR (kind = 'Group' AND direct_key IS NULL AND title IS NOT NULL AND department_id IS NULL)
      OR (
        kind = 'DepartmentWorkshop'
        AND direct_key IS NULL
        AND title IS NOT NULL
        AND department_id IS NOT NULL
      ),
      false
    )
  );
