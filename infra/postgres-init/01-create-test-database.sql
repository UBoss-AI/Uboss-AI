-- Runs once, on first initialisation of the data volume.
--
-- The integration tests need a database they can migrate and truncate freely without touching
-- development data, so a dedicated `uboss_test` database is created alongside `uboss_dev`.
CREATE DATABASE uboss_test OWNER uboss;

COMMENT ON DATABASE uboss_dev IS 'UBoss local development database.';
COMMENT ON DATABASE uboss_test IS 'UBoss integration test database. Safe to reset at any time.';
