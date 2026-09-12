-- CreateEnum
CREATE TYPE "person_identifier_kind" AS ENUM ('AadhaarEnteredOnly', 'WorkEmail', 'Other');

-- CreateEnum
CREATE TYPE "identifier_assurance" AS ENUM ('EnteredOnly', 'NotVerified');

-- CreateEnum
CREATE TYPE "employment_state" AS ENUM ('Active', 'Ended');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "mission" VARCHAR(1000),
ADD COLUMN     "vision" VARCHAR(1000);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "code" VARCHAR(20),
    "parent_department_id" UUID,
    "head_user_id" UUID,
    "description" VARCHAR(500),
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_id" VARCHAR(40) NOT NULL,
    "designation" VARCHAR(160) NOT NULL,
    "department_id" UUID NOT NULL,
    "reporting_manager_user_id" UUID,
    "state" "employment_state" NOT NULL DEFAULT 'Active',
    "joined_on" DATE,
    "employment_type" VARCHAR(60),
    "work_email" VARCHAR(320),
    "work_phone" VARCHAR(40),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "employment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_identifiers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "person_identifier_kind" NOT NULL,
    "match_hash" VARCHAR(64) NOT NULL,
    "match_key_id" VARCHAR(40) NOT NULL,
    "last_four" VARCHAR(4),
    "assurance" "identifier_assurance" NOT NULL DEFAULT 'EnteredOnly',
    "entered_by_tenant_id" UUID,
    "entered_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "person_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_tenant_id_parent_department_id_idx" ON "departments"("tenant_id", "parent_department_id");

-- CreateIndex
CREATE INDEX "departments_tenant_id_archived_at_idx" ON "departments"("tenant_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_name_key" ON "departments"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_id_key" ON "departments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "employment_records_tenant_id_reporting_manager_user_id_idx" ON "employment_records"("tenant_id", "reporting_manager_user_id");

-- CreateIndex
CREATE INDEX "employment_records_tenant_id_department_id_idx" ON "employment_records"("tenant_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_records_tenant_id_user_id_key" ON "employment_records"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employment_records_tenant_id_employee_id_key" ON "employment_records"("tenant_id", "employee_id");

-- CreateIndex
CREATE INDEX "person_identifiers_user_id_kind_idx" ON "person_identifiers"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "person_identifiers_kind_match_hash_key" ON "person_identifiers"("kind", "match_hash");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_parent_department_id_fkey" FOREIGN KEY ("tenant_id", "parent_department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_user_id_fkey" FOREIGN KEY ("head_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_tenant_id_reporting_manager_user_id_fkey" FOREIGN KEY ("tenant_id", "reporting_manager_user_id") REFERENCES "employment_records"("tenant_id", "user_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Prompt 12 — hand-written section
-- ===========================================================================
-- Everything below is written by hand rather than generated, because Prisma cannot express
-- Row-Level Security, check constraints or triggers.
--
-- The composite foreign keys it *can* express are declared in the schema instead, and appear in
-- the generated section above. That was not this migration's first draft — see section 1.
--
-- Five properties are enforced here rather than only in the service layer:
--
--   1. **Tenant isolation on the two new tenant-owned tables**, fail-closed like every other.
--   2. **A reporting manager must be in the same company.** A composite foreign key, declared
--      in the Prisma schema — see section 1 for why that matters and how the hand-written
--      version nearly got dropped.
--   3. **The reporting tree cannot contain a cycle.** A trigger with a bounded recursive walk.
--      A cycle makes the subtree query non-terminating, and `TeamSubtree` authorization now
--      depends on that query, so a cycle would be a denial-of-service on permission checks.
--   4. **A department-scoped role cannot name a department that does not exist.** The
--      authorization engine has carried opaque department ids since Prompt 7; PostgreSQL has no
--      foreign key on array elements, so this is the mechanism that closes it.
--   5. **`match_hash` cannot hold a raw identifier.** A 64-character-hex constraint means an
--      Aadhaar number written into that column is rejected by the database.

-- ---------------------------------------------------------------------------
-- 1. Same-tenant referential integrity — now declared in the Prisma schema
-- ---------------------------------------------------------------------------
-- Three foreign keys in the generated section above reference a **pair** rather than a single
-- column, so PostgreSQL refuses a department, a parent department or a reporting manager
-- belonging to another company (ADR-064):
--
--   * departments_tenant_id_parent_department_id_fkey
--   * employment_records_tenant_id_department_id_fkey
--   * employment_records_tenant_id_reporting_manager_user_id_fkey
--
-- The third is the one that matters most: it references this table's own (tenant_id, user_id),
-- so a reporting manager must be **employed by this company** — not merely be a user that
-- exists. A cross-tenant reporting line would be a tenant-isolation breach reachable through the
-- org chart, and every TeamSubtree authorization decision downstream would silently span the
-- boundary.
--
-- They are declared in the Prisma schema rather than written by hand here, which was this
-- migration's first draft. A constraint Prisma cannot see is **drift**, and the very next
-- generated migration emitted DROP CONSTRAINT for all three — caught while writing Prompt 13,
-- before it could run anywhere real.
--
-- `ON DELETE NO ACTION` rather than SET NULL: a composite key's SET NULL nulls every
-- referencing column including tenant_id, which is NOT NULL, so the delete would fail with a
-- confusing error rather than detaching the row. Nothing deletes these rows anyway — a
-- department is archived and an employment record is ended — so refusing is the honest action.

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security on the two new tenant-owned tables
-- ---------------------------------------------------------------------------
-- `FORCE ROW LEVEL SECURITY` so the policy applies to the table owner too, and both `USING` and
-- `WITH CHECK` so a row can be neither read nor written outside its tenant. Fail-closed: with no
-- `app.current_tenant_id` and no `app.platform_operation`, both expressions are false and the
-- table returns nothing.
--
-- `person_identifiers` deliberately has **no** RLS: it has no tenant column, because an
-- identifier belongs to a person rather than to a company — that is what makes cross-company
-- match-or-create possible at all. It is protected the same way `users` is (S-054): reachable
-- only through declared platform operations, and the match flow returns a decision rather than
-- rows. Recorded as S-066.

ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "departments_tenant_isolation" ON "departments"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

ALTER TABLE "employment_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employment_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY "employment_records_tenant_isolation" ON "employment_records"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR COALESCE(current_setting('app.platform_operation', true), '') = 'on'
  );

-- ---------------------------------------------------------------------------
-- 4. Check constraints, and the failure each prevents
-- ---------------------------------------------------------------------------

-- A department that is its own parent is an immediate cycle, and the recursive department query
-- would never terminate.
ALTER TABLE "departments"
  ADD CONSTRAINT "department_is_not_its_own_parent"
  CHECK ("parent_department_id" IS NULL OR "parent_department_id" <> "id");

ALTER TABLE "departments"
  ADD CONSTRAINT "department_name_is_not_blank"
  CHECK (length(btrim("name")) > 0);

ALTER TABLE "departments"
  ADD CONSTRAINT "department_sort_order_is_in_range"
  CHECK ("sort_order" BETWEEN 0 AND 10000);

-- Nobody reports to themselves. The trigger below catches longer cycles; this catches the
-- one-step case without a function call on every write.
ALTER TABLE "employment_records"
  ADD CONSTRAINT "employment_is_not_self_managed"
  CHECK ("reporting_manager_user_id" IS NULL OR "reporting_manager_user_id" <> "user_id");

ALTER TABLE "employment_records"
  ADD CONSTRAINT "employee_id_is_not_blank"
  CHECK (length(btrim("employee_id")) > 0);

ALTER TABLE "employment_records"
  ADD CONSTRAINT "designation_is_not_blank"
  CHECK (length(btrim("designation")) > 0);

-- "Ended" and "when" must agree in both directions. An ended employment with no end date cannot
-- be reported on, and an active one carrying an end date is a row two screens will read
-- differently.
ALTER TABLE "employment_records"
  ADD CONSTRAINT "employment_end_state_and_date_agree"
  CHECK (
    ("state" = 'Active' AND "ended_at" IS NULL)
    OR ("state" = 'Ended' AND "ended_at" IS NOT NULL)
  );

-- **The constraint that stops an Aadhaar number being stored.**
--
-- `match_hash` must be 64 lower-case hex characters — exactly a hex SHA-256 digest. A 12-digit
-- Aadhaar number written into this column is rejected by PostgreSQL, so the "we never store the
-- number" claim does not rest on the application getting it right every time.
ALTER TABLE "person_identifiers"
  ADD CONSTRAINT "match_hash_is_a_hex_digest"
  CHECK ("match_hash" ~ '^[0-9a-f]{64}$');

-- The only displayable fragment, and only four digits of it.
ALTER TABLE "person_identifiers"
  ADD CONSTRAINT "last_four_is_four_digits"
  CHECK ("last_four" IS NULL OR "last_four" ~ '^[0-9]{4}$');

ALTER TABLE "person_identifiers"
  ADD CONSTRAINT "match_key_id_is_not_blank"
  CHECK (length(btrim("match_key_id")) > 0);

-- ---------------------------------------------------------------------------
-- 5. The reporting tree cannot contain a cycle
-- ---------------------------------------------------------------------------
-- Walks upward from the proposed manager. If the walk reaches the row's own user, the edge would
-- close a loop and is refused.
--
-- Why a trigger and not only a service check: `TeamSubtree` authorization now runs a recursive
-- query over this tree on permission decisions. A cycle would make that query run until the
-- depth cap on *every* check — a denial of service on authorization, introduced by one bad
-- update. An invariant that load-bearing must not depend on which code path wrote the row.
--
-- The walk is bounded at 64 levels. The client asked for "practical unlimited levels"; 64 is far
-- beyond any real organisation and the bound exists so a pre-existing cycle (which this trigger
-- makes impossible, but a restored backup might contain) cannot hang the transaction.

CREATE OR REPLACE FUNCTION uboss_reporting_has_no_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_user uuid := NEW."reporting_manager_user_id";
  hops integer := 0;
BEGIN
  IF cursor_user IS NULL THEN
    RETURN NEW;
  END IF;

  WHILE cursor_user IS NOT NULL AND hops < 64 LOOP
    IF cursor_user = NEW."user_id" THEN
      RAISE EXCEPTION
        'Refusing to set a reporting manager that would create a cycle in the reporting tree '
        'for user % in tenant %.', NEW."user_id", NEW."tenant_id"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT e."reporting_manager_user_id"
      INTO cursor_user
      FROM "employment_records" e
     WHERE e."tenant_id" = NEW."tenant_id"
       AND e."user_id" = cursor_user;

    hops := hops + 1;
  END LOOP;

  IF hops >= 64 THEN
    RAISE EXCEPTION
      'The reporting chain above user % in tenant % exceeds 64 levels, which means it is either '
      'already broken or far deeper than any real organisation.', NEW."user_id", NEW."tenant_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "employment_reporting_has_no_cycle"
  BEFORE INSERT OR UPDATE OF "reporting_manager_user_id" ON "employment_records"
  FOR EACH ROW EXECUTE FUNCTION uboss_reporting_has_no_cycle();

-- ---------------------------------------------------------------------------
-- 6. A department-scoped role cannot name a department that does not exist
-- ---------------------------------------------------------------------------
-- Closes the gap the Prompt 7 schema comment described. A dangling department id in
-- `department_ids` silently changes somebody's scope, and there is nothing on any screen to look
-- at: the assignment reads as a normal Department grant that simply matches no resource.
--
-- Only `Department` and `MultipleDepartments` assignments are checked, because the column is
-- meaningless for the other scope kinds.

CREATE OR REPLACE FUNCTION uboss_role_departments_exist()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  offender text;
BEGIN
  IF NEW."scope_kind" NOT IN ('Department', 'MultipleDepartments')
     OR array_length(NEW."department_ids", 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- The format is checked before the cast, so a non-uuid value produces an explanation instead
  -- of PostgreSQL's raw "invalid input syntax for type uuid". The column is `text[]` — it has to
  -- be, since the authorization engine stores several kinds of subject id in the same shape —
  -- so a caller *can* put anything in it, and the message has to say what is wrong.
  SELECT candidate
    INTO offender
    FROM unnest(NEW."department_ids") AS candidate
   WHERE candidate !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   LIMIT 1;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      '"%" is not a department id. A Department-scoped role assignment must name real department '
      'uuids from this company; anything else silently matches no resource and looks like an '
      'ordinary grant.', offender
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT candidate
    INTO offender
    FROM unnest(NEW."department_ids") AS candidate
   WHERE NOT EXISTS (
           SELECT 1 FROM "departments" d
            WHERE d."id" = candidate::uuid
              AND d."tenant_id" = NEW."tenant_id"
         )
   LIMIT 1;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'Department % does not exist in tenant %, so a Department-scoped role assignment cannot '
      'name it. A dangling department id would silently change what this person can reach.',
      offender, NEW."tenant_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "role_assignment_departments_exist"
  BEFORE INSERT OR UPDATE OF "department_ids", "scope_kind" ON "role_assignments"
  FOR EACH ROW EXECUTE FUNCTION uboss_role_departments_exist();

-- ---------------------------------------------------------------------------
-- 7. Backfill: one department per existing company, and no invented employment
-- ---------------------------------------------------------------------------
-- Every existing company gets a single `General` department, because Add Employee requires a
-- department to select and a company with none cannot use the screen at all.
--
-- Employment records are **deliberately not backfilled.** An employee id, a designation and a
-- reporting manager are facts about a real person's job; inventing them would put fabricated
-- employment data in front of an administrator who would reasonably believe it. An empty
-- hierarchy that says "no employees recorded yet" is honest, and the screen says exactly that.
-- The demo companies get illustrative employees from the seed instead, which is where
-- illustrative data belongs (the Prompt 9 split between product configuration and demo data).

INSERT INTO "departments"
  ("id", "tenant_id", "name", "code", "description", "sort_order", "created_at", "updated_at",
   "row_version")
SELECT
  gen_random_uuid(), t."id", 'General', 'GEN',
  'Created by the Prompt 12 migration so this company has a department to assign people to. '
    || 'Rename it or add your own structure.',
  100, NOW(), NOW(), 1
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."tenant_id" = t."id");
