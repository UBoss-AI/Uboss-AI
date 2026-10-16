'use client';

import { useCallback, useEffect, useState } from 'react';

import { TOOL_ACTION_CATEGORIES, TOOL_CATEGORY_LABELS } from '@uboss/types';
import { Banner, Button } from '@uboss/ui';

import { ApiError, connectionsApi } from '../lib/api-client';

interface DiscoveredTool {
  name: string;
  description: string;
}

/**
 * Approving what an MCP server says it can do — CR-06.
 *
 * ## Why this screen exists at all
 *
 * An MCP server reports its own tools, and may report different ones tomorrow. UBoss cannot
 * know whether `delete_row` deletes or reads, and the five categories are what every control
 * downstream rests on — the agent's grant, the high-risk reason, the Executor's refusals. So a
 * person maps each tool once, and that mapping is what gets stored and enforced.
 *
 * ## Why the drift is shown before anything else
 *
 * If the list has moved since it was approved, that is the news. A tool that **appeared** is the
 * case the whole snapshot mechanism exists for: without it, Monday's approval for "read the
 * sheet" silently covers whatever the server added on Tuesday. A tool whose **shape changed** is
 * the quieter one — same name, different arguments — which is how a read becomes a write.
 *
 * ## Why a flagged description is shown and not hidden
 *
 * A tool whose own description reads like an instruction is a server trying to give orders to
 * this company's agents. Quietly stripping it would leave an administrator approving something
 * that looks ordinary. They are told, and they decide.
 */
export function McpToolApproval({
  tenantId,
  connectionId,
  onApproved,
}: {
  tenantId: string;
  connectionId: string;
  onApproved: () => void;
}) {
  const [tools, setTools] = useState<DiscoveredTool[] | null>(null);
  const [drift, setDrift] = useState<{ added: string[]; removed: string[]; changed: string[] }>({
    added: [],
    removed: [],
    changed: [],
  });
  const [suspicious, setSuspicious] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [neverApproved, setNeverApproved] = useState(true);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const read = useCallback(() => {
    setBusy(true);
    setError(null);
    setNote(null);

    void connectionsApi
      .discoverMcpTools(tenantId, connectionId)
      .then((answer) => {
        setTools(answer.tools.map((tool) => ({ name: tool.name, description: tool.description })));
        setDrift(answer.drift);
        setSuspicious(answer.suspicious);
        setApproved(answer.approved);
        setNeverApproved(!answer.everApproved);
        // Nothing is pre-chosen. A default of "Read" would be chosen by nobody and enforced as
        // though somebody had — which is the whole failure this screen prevents.
        setCategories({});
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That server could not be read.'),
      )
      .finally(() => setBusy(false));
  }, [tenantId, connectionId]);

  useEffect(read, [read]);

  const unmapped = (tools ?? []).filter((tool) => categories[tool.name] === undefined);

  const approve = () => {
    setBusy(true);
    setError(null);

    void connectionsApi
      .approveMcpTools(tenantId, connectionId, categories)
      .then((answer) => {
        setNote(answer.note);
        onApproved();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That list could not be approved.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="uboss-section-label">Tools this server offers</div>

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {note === null ? null : <Banner tone="ok">{note}</Banner>}

      {suspicious.length === 0 ? null : (
        <Banner tone="danger">
          {suspicious.join(', ')}: this tool&apos;s own description is written like an instruction
          to an AI rather than a description of what it does. That is how a server gives orders to
          another company&apos;s agents. UBoss never follows it — but consider whether this is a
          server to approve at all.
        </Banner>
      )}

      {/*
        Nothing approved yet, and a server that has moved, are different news.

        Before this, a brand-new connection was told "this server is not what was approved" and
        shown every tool it has as *added* — which reads as an alarm about a server nobody has
        looked at yet. The alarm is for the second case, and spending it on the first is how
        people learn to ignore it.
      */}
      {drift.added.length + drift.removed.length + drift.changed.length === 0 ? null : (
        <Banner tone={neverApproved ? 'info' : 'warn'}>
          {neverApproved ? (
            <>
              Nothing has been approved for this connection yet. Give each tool a category below and
              approve the list — until then no agent can use this server.
            </>
          ) : (
            <>
              This server is no longer what was approved.
              {drift.added.length === 0 ? '' : ` Added: ${drift.added.join(', ')}.`}
              {drift.removed.length === 0 ? '' : ` Gone: ${drift.removed.join(', ')}.`}
              {drift.changed.length === 0 ? '' : ` Changed: ${drift.changed.join(', ')}.`} Agents
              are held until the list is approved again.
            </>
          )}
        </Banner>
      )}

      {approved && drift.added.length === 0 ? (
        <Banner tone="ok">
          This list is approved and every tool has a category. Agents can be granted these below.
        </Banner>
      ) : null}

      {tools === null ? (
        <p className="uboss-muted">{busy ? 'Reading the server…' : 'Not read yet.'}</p>
      ) : (
        <>
          <p className="uboss-muted-3" style={{ fontSize: 12 }}>
            Say what each tool counts as. A tool with no category cannot be granted to anybody —
            every control UBoss has over an agent is written in these five words.
          </p>

          {tools.map((tool) => (
            <div key={tool.name} className="uboss-kv">
              <span className="uboss-kv-key">
                <span className="uboss-mono">{tool.name}</span>
                <br />
                {/*
                  The server's own sentence, shown as the server wrote it.

                  An administrator deciding whether to trust this needs to see exactly what it
                  says, including the parts that are trying something — which is why this screen
                  shows it raw while anything model-facing quarantines it.
                */}
                <span className="uboss-muted" style={{ fontSize: 12 }}>
                  {tool.description === '' ? 'No description given.' : tool.description}
                </span>
              </span>
              <span className="uboss-kv-value">
                <select
                  className="uboss-input"
                  value={categories[tool.name] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setCategories((current) => ({ ...current, [tool.name]: event.target.value }))
                  }
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {TOOL_ACTION_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {TOOL_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          ))}

          <div className="uboss-actions">
            <Button onClick={read} disabled={busy}>
              Read the server again
            </Button>
            <Button
              variant="primary"
              onClick={approve}
              disabled={busy || tools.length === 0 || unmapped.length > 0}
              title={
                unmapped.length === 0
                  ? undefined
                  : `${unmapped.length} tool${unmapped.length === 1 ? '' : 's'} still need a category.`
              }
            >
              {busy ? 'Approving…' : `Approve ${tools.length} tools`}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
