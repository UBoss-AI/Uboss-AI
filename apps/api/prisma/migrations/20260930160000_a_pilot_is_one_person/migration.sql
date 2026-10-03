-- A Pilot seats one person.
--
-- It seated twenty-five. That was set when Pilot meant "an evaluation for a department", and the
-- plan has changed: a Pilot is now a free workspace somebody signs themselves up for, to look
-- around with. Twenty-five seats on a free self-serve plan is a department running its work on a
-- tier nobody pays for — and since the seat ceiling is the only thing standing between a free
-- signup and a working team, that one number is the whole free tier.
--
-- One seat is the administrator's own. The seat count includes them — `SeatService` counts every
-- account in a counted state, and the first admin is Active — so a limit of 1 means they can
-- invite nobody. That is the intent: a Pilot is for one person to see the product, not for a team
-- to use it.
--
-- Left as data rather than made a constraint. A free plan carrying an AI allowance is refused by a
-- check constraint because that is money leaving UBoss for a provider; a free plan's seat count is
-- a commercial decision, and a future plan that seats three free users would be a decision, not a
-- mistake to be blocked.
UPDATE "plans"
   SET "seat_limit" = 1, "updated_at" = NOW()
 WHERE "code" = 'pilot';
