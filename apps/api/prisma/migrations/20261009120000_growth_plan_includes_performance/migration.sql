-- Growth gets the Performance module.
--
-- Performance was entitled on Enterprise alone. That made the Performance screen, and the
-- Task & Tracker grid built on top of it, invisible to every Growth company -- including the
-- customer who asked for the tracker, whose administrator held every grant it needs and still
-- had no entry in their sidebar, because `visibleModules` is filtered by the plan before the
-- grants are consulted.
--
-- The decision is the client's and it is deliberate: Growth and Enterprise, and no other tier.
-- Starter and Pilot are untouched below.
--
-- Written by hand rather than generated. `prisma migrate diff` carries pre-existing drift from
-- two migrations that were edited after they were applied, and nothing destructive belongs in an
-- additive change.

UPDATE "plans"
   SET "entitled_modules" = array_append("entitled_modules", 'performance'),
       "updated_at" = NOW(),
       "row_version" = "row_version" + 1
 WHERE "code" = 'growth'
   -- Idempotent: re-running must not append a second copy.
   AND NOT ('performance' = ANY ("entitled_modules"));
