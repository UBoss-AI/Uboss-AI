-- Starter is the same product as Growth. The difference is seats and allowance.
--
-- ## The decision this applies
--
-- Asked which way Starter should differ from Growth, the choice was (a): **the same product, with
-- a smaller team and a smaller allowance** — rather than a cut-down version missing features.
--
-- Starter has been carrying six modules against Growth's twelve, so a ten-person company on
-- Starter could not build an agent, run one, approve anything, or read a report. That is not a
-- smaller version of the product; it is a different product, and it is not the one that was sold.
--
-- ## Why this is six specific modules and not "everything"
--
-- Enterprise carries two more again — `performance` and `roles` — and those stay where they are.
-- Custom roles are a permission set a company writes inside its own ceiling, and company-wide
-- performance scoring is a governance surface; both are things an enterprise buyer asks for and
-- negotiates. The decision was that Starter and Growth are the same product, not that every tier
-- is.
--
-- ## Why existing companies are not touched
--
-- This changes the **plan**, which is the catalogue. A company's own entitlements are the plan's
-- modules layered with whatever was added or removed for it specifically, and that layering is
-- read at request time — so every company already on Starter gains these modules at its next
-- request, without a row of theirs being rewritten.
--
-- Nothing is removed from any plan here. A module list that only grows cannot take a feature away
-- from somebody who had it yesterday.

UPDATE "plans"
   SET "entitled_modules" = ARRAY[
         'dashboard',
         'hierarchy',
         'objective',
         'agent-builder',
         'todo',
         'agents',
         'executor',
         'approvals',
         'reports',
         'users',
         'profile-search',
         'settings'
       ],
       "updated_at" = NOW()
 WHERE "code" = 'starter';
