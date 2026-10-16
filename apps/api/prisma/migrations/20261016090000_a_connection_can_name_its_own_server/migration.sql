-- A connection can name its own server, and remember the tools it was approved with — CR-06.
--
-- Both columns exist for one connector kind, `custom-mcp`, and are null for every other. That is
-- deliberate rather than a sign they belong elsewhere: a connection is already the row that holds
-- "how we reach that system and what we may do there", and a second table would mean two rows to
-- disable, two to transfer, and two places for a credential to outlive its owner.
--
-- `endpoint` is the server's address. Every connector until now reached a vendor its adapter
-- already knew, so there was nothing to record; an MCP server is one the company brings, which is
-- the whole point of the feature.
--
-- `tool_snapshot` is the tool list as it stood when somebody approved it, with the category a
-- person assigned each tool. An MCP server reports its own tools and may report different ones
-- tomorrow — so what was approved has to be written down, or a connection approved on Monday for
-- "read the sheet" silently covers whatever the server added on Tuesday.
--
-- Nullable, with no default and no backfill: a null snapshot means "nobody has approved a tool
-- list for this connection", which is exactly true of every connection that exists today.
--
-- No RLS policy is added: `connections` already carries one on `tenant_id`, and neither column
-- adds a way to reach a row.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "endpoint" VARCHAR(2000),
ADD COLUMN     "tool_snapshot" JSONB;
