-- What this person actually covers, beyond their job title.
--
-- Asked for by the client: "ek manager ke 2-3 sub-department hain, to vo specialization me likh
-- lega". A designation says what somebody is called; it does not say which ground they hold. A
-- manager over three sub-departments and a manager over one carry the same title, and the chart
-- could not tell them apart.
--
-- Nullable, and that is not a half-measure.
--
-- Every employment record that already exists was created without this, and a column added today
-- cannot retroactively make yesterday's records wrong. NOT NULL would need a backfill, and the
-- only honest value to backfill with is "we do not know" — which is what NULL already says, with
-- the advantage that nothing later mistakes it for an answer somebody gave.
--
-- The Add Employee form asks for it and marks it required, because there the person is in front
-- of you. The import leaves it optional: requiring it would refuse spreadsheets that were correct
-- yesterday, and the template only ever stars what the server genuinely enforces.
ALTER TABLE "employment_records" ADD COLUMN "specialization" VARCHAR(300);

COMMENT ON COLUMN "employment_records"."specialization" IS
  'Areas, sub-departments or disciplines this person covers. Free text: the shape differs by company and a closed list would be wrong for most of them.';
