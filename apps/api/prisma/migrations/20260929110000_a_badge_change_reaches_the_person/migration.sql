-- Crossing a badge threshold changed a row and wrote an audit event, and the person whose badge
-- it was found out by opening the screen. A ladder nobody is told they have climbed is a report.
--
-- Its own kind rather than borrowing one: a badge is somebody's standing, not work waiting on
-- them, and a preference screen that offered no way to say "not this" would either silence
-- something else along with it or be unmutable for no reason.
--
-- Additive. PostgreSQL 12 and later permit this inside a transaction as long as the new value is
-- not used in the same one, and nothing here uses it.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'Badge';
