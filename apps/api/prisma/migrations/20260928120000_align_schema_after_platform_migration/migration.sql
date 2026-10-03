-- Bring the database objects in line with the Prisma schema without rebuilding tables.
DROP INDEX "agent_builder_test_runs_history_idx";
DROP INDEX "sso_auth_requests_expires_at_idx";

CREATE INDEX "agent_builder_test_runs_tenant_id_ai_work_assignment_id_cre_idx"
  ON "agent_builder_test_runs"("tenant_id", "ai_work_assignment_id", "created_at");
CREATE INDEX "chat_conversations_tenant_id_department_id_idx"
  ON "chat_conversations"("tenant_id", "department_id");
CREATE INDEX "invitations_expires_at_idx"
  ON "invitations"("expires_at");

ALTER TABLE "agent_builder_test_runs"
  RENAME CONSTRAINT "agent_builder_test_runs_assignment_fk"
  TO "agent_builder_test_runs_tenant_id_ai_work_assignment_id_fkey";
ALTER TABLE "agent_builder_test_runs"
  RENAME CONSTRAINT "agent_builder_test_runs_ran_by_fk"
  TO "agent_builder_test_runs_ran_by_user_id_fkey";
ALTER TABLE "agent_builder_test_runs"
  RENAME CONSTRAINT "agent_builder_test_runs_tenant_fk"
  TO "agent_builder_test_runs_tenant_id_fkey";
ALTER TABLE "chat_conversations"
  RENAME CONSTRAINT "chat_conversations_department_fk"
  TO "chat_conversations_tenant_id_department_id_fkey";
ALTER INDEX "one_pack_per_company"
  RENAME TO "tenant_skill_packs_tenant_id_industry_key";
