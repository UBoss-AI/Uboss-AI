-- Where a service alert is sent.
--
-- `service_alerts` has been a table somebody reads. Nothing wrote to it outside the seed, and
-- nothing told anybody when one appeared — so the Master Console's "open incidents" tile counted
-- demo rows, and a real failure would have waited for a person to open the screen and notice.
--
-- A webhook rather than an email list: platform operations already run through something that
-- takes a POST — Slack, PagerDuty, an on-call bridge — and building a second recipient model here
-- would be a rota nobody maintains. It also needs no address book, which matters because platform
-- staff belong to no tenant and the notification engine is tenant-scoped.
--
-- **Empty is a valid deployment**, and an honest one: it means nothing is being alerted, the
-- alert row is still written, and the service says so rather than claiming a delivery.
INSERT INTO "platform_settings"
  ("id", "key", "value", "description", "section", "locked",
   "created_at", "updated_at", "row_version")
VALUES
  (gen_random_uuid(), 'operations.alert_webhook_url', '""'::jsonb,
   'Where a service alert is POSTed as JSON — a Slack incoming webhook, PagerDuty, or any '
     || 'endpoint that accepts one. Empty means alerts are recorded and nobody is told, which '
     || 'is a choice rather than a default: the console still shows them.',
   'Operations', false, NOW(), NOW(), 1)
ON CONFLICT ("key") DO NOTHING;

-- One open alert per (service, summary). Without it a provider failing every minute opens a
-- thousand identical incidents and the console becomes unreadable at exactly the moment it
-- matters. A resolved one does not block a new one: the same thing breaking again is news.
CREATE UNIQUE INDEX IF NOT EXISTS "one_open_alert_per_service_and_summary"
  ON "service_alerts" ("service", "summary")
  WHERE "state" <> 'Resolved';
