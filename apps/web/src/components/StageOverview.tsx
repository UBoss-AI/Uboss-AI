'use client';

import {
  ORCHESTRATION_STAGE_LABELS,
  type OrchestrationStageRow,
  type OrchestrationView,
} from '@uboss/types';
import { Card, CardBody } from '@uboss/ui';

/**
 * Where the company's work has actually got to.
 *
 * ## Why a table and not more tiles
 *
 * Engine, Sub-Engine and Executor are positions in a sequence, so their numbers only say anything
 * beside one another: sixty ready at Engine and nothing at Executor is a company that has not
 * started, and the reverse is one that is nearly finished. Split across separate cards, that
 * reading is gone — which is why the tiles above could not answer this question however many of
 * them there were.
 *
 * ## Waiting is given its own column, first
 *
 * Work that has an owner and cannot be started. It reads as the admin's queue to clear rather than
 * as an employee who has not got round to something, and it is first because it is the column
 * somebody opens this screen to look at.
 *
 * Every number here was counted by the server in this reader's own scope. Nothing is projected,
 * and a figure this person may not see arrives as null rather than as zero — so "—" here means
 * "not yours to see", and \`0\` always means zero.
 */
export function StageOverview({ view }: { view: OrchestrationView }): React.JSX.Element {
  return (
    <Card>
      <CardBody>
        <div className="uboss-section-label" style={{ marginTop: 0 }}>
          Where the work is
        </div>

        <div className="uboss-stage-summary">
          <Figure label="Active objectives" value={view.activeObjectives} />
          <Figure label="Waiting on something" value={view.waitingOnDependency} />
          <Figure label="Overdue" value={view.overdue} />
          <Figure label="Approvals pending" value={view.approvalsPending} />
          <Figure label="Open exceptions" value={view.exceptionsOpen} />
        </div>

        <table className="uboss-stage-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Done by</th>
              <th scope="col">Waiting</th>
              <th scope="col">Ready</th>
              <th scope="col">In progress</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {view.stages.map((row) => (
              <StageRows key={row.stage} row={row} />
            ))}
          </tbody>
        </table>

        {view.departments.length === 0 ? null : (
          <>
            <div className="uboss-section-label">By department</div>
            <table className="uboss-stage-table">
              <thead>
                <tr>
                  <th scope="col">Department</th>
                  <th scope="col">Objectives</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Overdue</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {view.departments.map((department) => (
                  <tr key={department.departmentId}>
                    <th scope="row">{department.name}</th>
                    <td>{department.activeObjectives}</td>
                    <td>{department.waiting}</td>
                    <td className={department.overdue > 0 ? 'uboss-stage-alarm' : undefined}>
                      {department.overdue}
                    </td>
                    <td>{department.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/*
          Said once, at the foot.

          Two people with different authority legitimately see different numbers here, and a screen
          that does not say whose work it is counting invites them to argue about which of the two
          is broken.
        */}
        <p className="uboss-muted-3">{view.covers}</p>
      </CardBody>
    </Card>
  );
}

/**
 * One stage, as two rows: the people and the agents.
 *
 * Kept apart rather than summed. "Forty ready" means something different when thirty of them are
 * waiting on a person and ten on an agent nobody has built, and the whole point of this product is
 * that those two are different kinds of work.
 */
function StageRows({ row }: { row: OrchestrationStageRow }): React.JSX.Element {
  return (
    <>
      <tr>
        <th scope="row" rowSpan={2}>
          {ORCHESTRATION_STAGE_LABELS[row.stage]}
        </th>
        <th scope="row">People</th>
        <td className={row.human.waiting > 0 ? 'uboss-stage-queue' : undefined}>
          {row.human.waiting}
        </td>
        <td>{row.human.ready}</td>
        <td>{row.human.inProgress}</td>
        <td>{row.human.completed}</td>
      </tr>
      <tr className="uboss-stage-agent-row">
        <th scope="row">Agents</th>
        <td className={row.agent.waiting > 0 ? 'uboss-stage-queue' : undefined}>
          {row.agent.waiting}
        </td>
        <td>{row.agent.ready}</td>
        <td>{row.agent.inProgress}</td>
        <td>{row.agent.completed}</td>
      </tr>
    </>
  );
}

/** One headline number. `null` prints an em dash: the reader may not see it, and zero would lie. */
function Figure({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  return (
    <div className="uboss-stage-figure">
      <span className="uboss-stage-figure-value">{value === null ? '—' : value}</span>
      <span className="uboss-stage-figure-label">{label}</span>
    </div>
  );
}
