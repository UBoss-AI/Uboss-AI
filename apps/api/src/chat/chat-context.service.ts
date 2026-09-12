import { Injectable, Logger } from '@nestjs/common';

import {
  CONTEXT_PERMISSION,
  restrictedPreview,
  type ChatContextPreview,
  type ChatContextRef,
  type ChatContextType,
} from '@uboss/types';
import type { Action, ModuleKey } from '@uboss/types';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ResourceDescriptor } from '@uboss/types';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * Resolving what a conversation is *about*, against the viewer's own permissions — Prompt 40A §6.
 *
 * ## The escalation this class exists to prevent
 *
 * Without it, chat is the easiest privilege escalation in the product. A conversation can reference
 * a restricted Objective; if the reference carried a cached title, or if the preview were resolved
 * with the *conversation's* authority instead of the *reader's*, then anybody who could get into
 * the conversation could read the Objective's name — and no permission check would ever have run
 * near it, because the check was on the conversation and the conversation was theirs.
 *
 * So two rules, and both are structural rather than remembered:
 *
 * 1. **The stored row is a type and an id.** There is nowhere to cache a title, so nothing can go
 *    stale and nothing can leak by sitting in the wrong table.
 * 2. **Every preview is resolved per viewer, at read time**, against the resource's **own** module
 *    permission — `objective:View` for an Objective, `todo:View` for a task — exactly as that
 *    resource's own screen would. Never against a `chat` permission, which would make chat an
 *    authority of its own.
 *
 * A viewer without access gets a stated refusal, not a blank. `restrictedPreview` is the one
 * wording, produced in one place, so six resolvers cannot each invent a message that reveals
 * something.
 *
 * ## Losing access removes the preview
 *
 * Nobody has to edit the conversation. The reference stays; the preview stops resolving. That is
 * the property a cache could not have.
 */
@Injectable()
export class ChatContextService {
  private readonly logger = new Logger(ChatContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Resolve every reference on a conversation for one viewer.
   *
   * Sequential rather than `Promise.all`, deliberately: each resolver reads inside a tenant
   * transaction, and `Promise.all` across an open interactive transaction loses the
   * `AsyncLocalStorage` scope — a mistake this codebase has made before and which presents as a
   * query seeing no rows rather than as an error.
   */
  async previewAll(input: {
    scope: TenantScope;
    viewerUserId: string;
    refs: readonly ChatContextRef[];
  }): Promise<ChatContextPreview[]> {
    const previews: ChatContextPreview[] = [];
    for (const ref of input.refs) {
      previews.push(
        await this.preview({
          scope: input.scope,
          viewerUserId: input.viewerUserId,
          ref,
        }),
      );
    }
    return previews;
  }

  /**
   * Resolve one reference, or refuse it.
   *
   * Permission first, then the row — and that order matters. Reading the row first and then
   * checking would mean the resource had already been fetched into memory for somebody not allowed
   * to see it, which is one refactor away from being returned.
   */
  async preview(input: {
    scope: TenantScope;
    viewerUserId: string;
    ref: ChatContextRef;
  }): Promise<ChatContextPreview> {
    const required = CONTEXT_PERMISSION[input.ref.type];

    const context = await this.authorization.contextFor(input.scope, input.viewerUserId);
    const decision = await this.authorization.authorize(context, {
      module: required.module as ModuleKey,
      action: required.action as Action,
    });

    if (!decision.allowed) return restrictedPreview(input.ref);

    const resolved = await this.read(input.scope, input.ref);
    // Not found is reported as restricted, not as "deleted".
    //
    // Deliberate: the two are indistinguishable to a viewer who should not see it either way, and
    // saying "that no longer exists" to somebody who never had access confirms that it once did.
    if (resolved === null) return restrictedPreview(input.ref);

    /**
     * A second check, on the row.
     *
     * The first check answers "may this person see Objectives at all"; this one answers "may they
     * see *this* Objective". Scope is the whole point of the authorization model — an Employee
     * with `OwnWork` holds `todo:View` and still must not read a colleague's task — and a
     * module-level check alone would grant exactly that.
     *
     * ## Where the descriptor is incomplete, the answer is a refusal
     *
     * Only `objectives` carries a department of its own; a task, approval or exception borrows one
     * through the objective it belongs to, and an Engine Agent has none at all. So a
     * department-scoped person may be refused a preview of an agent they could open on its own
     * screen.
     *
     * That is the **safe direction and it is deliberate**: an incomplete descriptor makes a preview
     * more restrictive, never less. The alternative — omitting the resource check when the shape is
     * awkward — would show a preview to somebody the scope engine would have refused, which is the
     * failure this class exists to prevent.
     */
    const onResource = await this.authorization.authorize(context, {
      module: required.module as ModuleKey,
      action: required.action as Action,
      resource: resolved.descriptor,
    });
    if (!onResource.allowed) return restrictedPreview(input.ref);

    return {
      accessible: true,
      type: input.ref.type,
      id: input.ref.id,
      title: resolved.title,
      status: resolved.status,
      deepLink: resolved.deepLink,
    };
  }

  /**
   * Read the one row behind a reference.
   *
   * A `switch` over the closed set rather than a registry, so **adding a seventh context type is a
   * type error here**. A registry keyed by string would let a later prompt add a type with no
   * resolver and get an unchecked preview by default, which is the failure mode this whole class
   * is built against.
   *
   * Every query is tenant-scoped as well as id-scoped. RLS would catch a missing tenant filter, and
   * the filter is written anyway: two independent mechanisms for the thing that must not fail.
   */
  private async read(scope: TenantScope, ref: ChatContextRef): Promise<Resolved | null> {
    const type: ChatContextType = ref.type;

    /** The department an objective-anchored resource inherits, or undefined. */
    const departmentOf = async (objectiveId: string | null): Promise<string | undefined> => {
      if (objectiveId === null) return undefined;
      const objective = await this.prisma.client.objective.findFirst({
        where: { tenantId: scope.tenantId, id: objectiveId },
        select: { departmentId: true },
      });
      return objective?.departmentId;
    };

    return this.prisma.runInTenantTransaction(scope, async (): Promise<Resolved | null> => {
      switch (type) {
        case 'Objective': {
          const row = await this.prisma.client.objective.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: {
              id: true,
              code: true,
              activeVersionId: true,
              objectiveOwnerUserId: true,
              departmentId: true,
            },
          });
          if (row === null) return null;

          /**
           * The name and the status live on the **version**, not on the objective.
           *
           * And the *active* version specifically — not the newest. An objective with a live
           * version and a newer draft must preview as what is in force, because the draft is
           * somebody's unpublished thinking and a chat preview is not where that should surface.
           * An objective with nothing published yet previews by its code, which is what the
           * Objective screens show in the same situation.
           */
          const active =
            row.activeVersionId === null
              ? null
              : await this.prisma.client.objectiveVersion.findFirst({
                  where: { tenantId: scope.tenantId, id: row.activeVersionId },
                  select: { objectiveName: true, status: true },
                });

          return {
            title: active?.objectiveName ?? row.code,
            status: active?.status ?? 'Draft',
            deepLink: `/objective/${row.id}`,
            descriptor: {
              id: row.id,
              ownerUserId: row.objectiveOwnerUserId,
              createdByUserId: row.objectiveOwnerUserId,
              departmentId: row.departmentId,
            },
          };
        }

        case 'HumanTask': {
          const row = await this.prisma.client.humanTask.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: {
              id: true,
              title: true,
              status: true,
              assignedToUserId: true,
              objectiveId: true,
            },
          });
          if (row === null) return null;
          return {
            title: row.title,
            status: row.status,
            deepLink: `/todo/${row.id}`,
            descriptor: {
              id: row.id,
              ownerUserId: row.assignedToUserId,
              createdByUserId: row.assignedToUserId,
              ...(await withDepartment(departmentOf(row.objectiveId))),
            },
          };
        }

        case 'EngineAgent': {
          const row = await this.prisma.client.engineAgent.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: { id: true, name: true, status: true, ownerUserId: true },
          });
          if (row === null) return null;
          return {
            title: row.name,
            status: row.status,
            deepLink: `/agents/${row.id}`,
            // No department: an Engine Agent belongs to a company, not to a department.
            descriptor: {
              id: row.id,
              ownerUserId: row.ownerUserId,
              createdByUserId: row.ownerUserId,
            },
          };
        }

        case 'AgentRun': {
          const row = await this.prisma.client.agentRun.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: {
              id: true,
              state: true,
              engineAgentId: true,
              agent: { select: { name: true, ownerUserId: true } },
            },
          });
          if (row === null) return null;
          return {
            // The run's own identity is a uuid, which tells a reader nothing. Named by the agent
            // that produced it, which is how the Engine Agents screen refers to it too.
            title: `Run of ${row.agent.name}`,
            status: row.state,
            deepLink: `/agents/${row.engineAgentId}/runs/${row.id}`,
            descriptor: {
              id: row.id,
              ownerUserId: row.agent.ownerUserId,
              createdByUserId: row.agent.ownerUserId,
            },
          };
        }

        case 'ApprovalRequest': {
          const row = await this.prisma.client.approvalRequest.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: {
              id: true,
              type: true,
              state: true,
              requestedByUserId: true,
              objectiveId: true,
            },
          });
          if (row === null) return null;
          return {
            // The approval's *type*, not its subject. A subject line could name a restricted
            // objective, and this preview is shown to anybody in the conversation who holds
            // `approvals:View` — which is not the same as holding access to what it is about.
            title: `Approval: ${row.type}`,
            status: row.state,
            deepLink: `/approvals/${row.id}`,
            descriptor: {
              id: row.id,
              ownerUserId: row.requestedByUserId,
              createdByUserId: row.requestedByUserId,
              ...(await withDepartment(departmentOf(row.objectiveId))),
            },
          };
        }

        case 'ExecutorException': {
          const row = await this.prisma.client.executorException.findFirst({
            where: { tenantId: scope.tenantId, id: ref.id },
            select: { id: true, kind: true, state: true, ownerUserId: true, objectiveId: true },
          });
          if (row === null) return null;
          return {
            // The kind, not the detail. The detail can quote a failure message, and a failure
            // message can quote customer data.
            title: `Exception: ${row.kind}`,
            status: row.state,
            deepLink: `/executor/${row.id}`,
            descriptor: {
              id: row.id,
              ...(row.ownerUserId === null
                ? {}
                : { ownerUserId: row.ownerUserId, createdByUserId: row.ownerUserId }),
              ...(await withDepartment(departmentOf(row.objectiveId))),
            },
          };
        }
      }
    });
  }
}

/** What one reference resolves to: what to show, and what the scope engine needs to judge it. */
interface Resolved {
  title: string;
  status: string | null;
  deepLink: string;
  descriptor: ResourceDescriptor;
}

/**
 * Spread a department into a descriptor only when there is one.
 *
 * `exactOptionalPropertyTypes` is on, so `{ departmentId: undefined }` is not the same as an
 * absent key — and the scope engine treats an explicitly-undefined department differently from a
 * missing one. This keeps the distinction without a conditional at six call sites.
 */
async function withDepartment(
  departmentId: Promise<string | undefined>,
): Promise<{ departmentId?: string }> {
  const resolved = await departmentId;
  return resolved === undefined ? {} : { departmentId: resolved };
}
