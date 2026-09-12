import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { CompanySetupTask } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { COMPANY_SETUP_TASKS } from './company-setup-tasks.js';

export interface SetupChecklistView {
  tasks: {
    key: string;
    position: number;
    title: string;
    rationale: string;
    targetRoute: string | null;
    state: CompanySetupTask['state'];
    skipReason: string | null;
    completedAt: string | null;
  }[];
  /** Done or deliberately skipped, over the total. What the progress bar shows. */
  resolved: number;
  total: number;
  percentComplete: number;
  /** The lowest-positioned unresolved task — the client's "next recommended action". */
  nextTask: { key: string; title: string; targetRoute: string | null } | null;
  complete: boolean;
}

/**
 * The first-login Company Setup Checklist.
 *
 * The client's requirement, verbatim: *"On first login, Aarav should not land on an empty
 * dashboard. UBoss shows setup progress and the next recommended actions."* And, from the same
 * section's screen note: *"First-login setup guidance is handled in a separate Setup Checklist /
 * Setup Wizard. It is not displayed as extra Dashboard cards."*
 *
 * Both halves matter. The checklist has to exist and be prominent, and it must **not** be
 * scattered across the dashboard as tiles — the Company Workspace Dashboard has a locked
 * one-donut layout that extra cards would break.
 *
 * ## Skipping is allowed, and requires a reason
 *
 * A checklist item that cannot be skipped is an item people work around — they mark it done
 * without doing it, and the checklist stops meaning anything. `Skipped` with a written reason is
 * the honest state, and a check constraint requires the reason, because "skipped" with no
 * explanation is indistinguishable from "forgotten".
 *
 * ## Progress counts resolved, not done
 *
 * A company that legitimately skipped "add external guests" is not permanently at 90%. Skipped
 * counts toward resolution and stays visible as skipped, which is a different claim from done.
 */
@Injectable()
export class CompanySetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /**
   * The checklist for one company.
   *
   * Requires `settings:View`, which every company role holds — the checklist is the thing a new
   * administrator needs on their first login, and gating it behind `Administer` would mean the
   * person who most needs it is the only one who can see it while everybody else wonders what
   * to do.
   */
  async checklistFor(scope: TenantScope, userId: string): Promise<SetupChecklistView> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    const tasks = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.companySetupTask.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { position: 'asc' },
      }),
    );

    return CompanySetupService.summarise(tasks);
  }

  /**
   * Mark a task done, in progress, or skipped.
   *
   * Requires `settings:EditDraft` rather than `Administer`: completing setup steps is the work of
   * whoever is bringing the workspace up, and in practice that includes people the Company Admin
   * has delegated to. Changing global settings is a different, narrower thing.
   */
  async updateTask(input: {
    scope: TenantScope;
    userId: string;
    key: string;
    state: CompanySetupTask['state'];
    skipReason?: string | undefined;
  }): Promise<SetupChecklistView> {
    const context = await this.authorization.contextFor(input.scope, input.userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });

    if (input.state === 'Skipped' && !input.skipReason?.trim()) {
      throw new BadRequestException(
        'Skipping a setup step requires a reason. "Skipped" with no explanation is ' +
          'indistinguishable from "forgotten", and the checklist exists to tell those apart.',
      );
    }

    const known = COMPANY_SETUP_TASKS.find((task) => task.key === input.key);
    if (!known) {
      throw new NotFoundException(
        `"${input.key}" is not a setup task. The checklist is a fixed list from the approved ` +
          'onboarding sequence, not a to-do list.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.companySetupTask.findFirst({
        where: { tenantId: input.scope.tenantId, key: input.key },
      });
      if (!existing) {
        throw new NotFoundException('That setup task does not exist for this company.');
      }
      if (existing.state === input.state && input.state !== 'Skipped') {
        throw new ConflictException(`That step is already "${input.state}".`);
      }

      const done = input.state === 'Done';
      await this.prisma.client.companySetupTask.update({
        where: { id: existing.id },
        data: {
          state: input.state,
          skipReason: input.state === 'Skipped' ? (input.skipReason?.trim() ?? null) : null,
          completedAt: done || input.state === 'Skipped' ? new Date() : null,
          completedByUserId: done || input.state === 'Skipped' ? input.userId : null,
          version: { increment: 1 },
        },
      });

      // Audited into the company's own trail. Onboarding progress is company history — "who
      // decided we did not need guest access" is a real question a year later.
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: `company_setup.${input.state === 'Skipped' ? 'skipped' : 'progressed'}`,
        resourceType: 'company_setup_task',
        resourceId: existing.id,
        resourceRef: existing.key,
        resourceVersion: existing.version,
        actorUserId: input.userId,
        summary: `Setup step "${existing.title}" set to ${input.state}.`,
        ...(input.skipReason ? { reason: input.skipReason.trim() } : {}),
        metadata: { key: existing.key, position: existing.position, state: input.state },
      });

      const tasks = await this.prisma.client.companySetupTask.findMany({
        where: { tenantId: input.scope.tenantId },
        orderBy: { position: 'asc' },
      });
      return CompanySetupService.summarise(tasks);
    });
  }

  /**
   * Derive progress and the next recommended action.
   *
   * A pure static so the arithmetic is testable without a database — and worth testing, because
   * "resolved counts skipped, complete requires nothing unresolved" is the kind of rule that
   * looks obvious and is easy to get subtly wrong.
   */
  static summarise(tasks: readonly CompanySetupTask[]): SetupChecklistView {
    const resolved = tasks.filter(
      (task) => task.state === 'Done' || task.state === 'Skipped',
    ).length;
    const next = tasks.find((task) => task.state !== 'Done' && task.state !== 'Skipped');

    return {
      tasks: tasks.map((task) => ({
        key: task.key,
        position: task.position,
        title: task.title,
        rationale: task.rationale,
        targetRoute: task.targetRoute,
        state: task.state,
        skipReason: task.skipReason,
        completedAt: task.completedAt?.toISOString() ?? null,
      })),
      resolved,
      total: tasks.length,
      percentComplete: tasks.length === 0 ? 0 : Math.round((resolved / tasks.length) * 100),
      nextTask: next ? { key: next.key, title: next.title, targetRoute: next.targetRoute } : null,
      complete: tasks.length > 0 && resolved === tasks.length,
    };
  }
}
