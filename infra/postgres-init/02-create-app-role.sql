-- The application connects as this deliberately unprivileged role so Row-Level Security
-- actually applies to it: the owner role `uboss` is a superuser with BYPASSRLS, which would
-- silently skip every policy.
--
-- The migration `20260908093000_row_level_security_defence_in_depth` also creates this role
-- idempotently, so an existing volume is upgraded. This file covers a fresh volume.
--
-- Local development password only. Real environments create this role out of band with a
-- credential from a secret manager.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uboss_app') THEN
    CREATE ROLE uboss_app LOGIN PASSWORD 'uboss_app_local_dev' NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;
