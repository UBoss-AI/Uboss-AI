-- ===========================================================================
-- Fix: the graph-shape constraints failed OPEN on a missing key
-- ===========================================================================
-- `jsonb_typeof(graph -> 'edges')` returns NULL when the key is absent, and `NULL = 'array'` is
-- NULL, not FALSE. A CHECK constraint only refuses a row when its expression evaluates to FALSE,
-- so `{"nodes":[{...}]}` with no `edges` key at all passed the very constraint written to catch
-- it. The previous migration is already applied, so this is corrected append-only rather than by
-- editing history.
--
-- Found by probing each constraint in raw SQL before any code depended on it. A missing `edges`
-- key is not a hypothetical: it is what a hand-written fixture or an older writer produces, and
-- it would have surfaced as a screen that renders nodes with no connections between them.

ALTER TABLE "objective_workflow_drafts"
  DROP CONSTRAINT "workflow_draft_graph_has_nodes_and_edges";

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_graph_has_nodes_and_edges"
  CHECK (COALESCE(jsonb_typeof("graph" -> 'nodes'), 'missing') = 'array'
         AND COALESCE(jsonb_typeof("graph" -> 'edges'), 'missing') = 'array');

-- Same class of problem, plus one more: `jsonb_array_length` RAISES on a non-array instead of
-- returning NULL, so the old form's behaviour depended on which constraint Postgres happened to
-- evaluate first. Guarding on the type makes this constraint answer only the question it owns —
-- "is the node list empty?" — and leaves "is it a list at all?" to the constraint above.

ALTER TABLE "objective_workflow_drafts"
  DROP CONSTRAINT "workflow_draft_has_at_least_one_node";

ALTER TABLE "objective_workflow_drafts"
  ADD CONSTRAINT "workflow_draft_has_at_least_one_node"
  CHECK (jsonb_typeof("graph" -> 'nodes') IS DISTINCT FROM 'array'
         OR jsonb_array_length("graph" -> 'nodes') >= 1);
