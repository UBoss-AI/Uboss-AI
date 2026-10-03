import { Injectable, Logger } from '@nestjs/common';
import type { CompanyModuleKey } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';

/**
 * Which modules a company is actually paying for.
 *
 * ## The gap this closes
 *
 * `entitled_modules` decided what the sidebar drew and nothing else. Every company module is a
 * sellable one — the fourteen in `COMPANY_MODULES` are exactly the fourteen the Enterprise plan
 * lists — and the role templates grant permissions for all of them regardless of plan. So an
 * admin on **Pilot**, which entitles five, held role grants for fourteen and the API answered
 * all fourteen. Hiding a navigation item was the only thing between a Pilot customer and the
 * Enterprise feature set, and a URL got round it.
 *
 * Proven rather than reasoned: on the development company, which is on `growth` and is not
 * entitled to `performance`, `GET /tenants/:id/performance/me` returned **200** with real data.
 *
 * ## Why "no subscription" means "no gate"
 *
 * A company provisioned without a commercial subscription is not on a plan, so there is nothing
 * to withhold — and reading an absent subscription as "entitled to nothing" would lock such a
 * company out of its own product entirely. Two already exist in development. This returns `null`
 * for them, and `null` means *do not gate*, which is a different answer from an empty set.
 *
 * ## Why it is cached
 *
 * This is consulted by the global permission guard, so it is on the path of every authorized
 * request. A plan changes rarely and a request happens constantly, so the answer is held for a
 * few seconds. A plan change therefore takes effect within `TTL_MS` rather than instantly, which
 * is the trade this cache is: an upgrade a customer just paid for appears within seconds, and a
 * downgrade closes within seconds. Both are acceptable; a database read per request is not.
 */
@Injectable()
export class ModuleEntitlementService {
  private readonly logger = new Logger(ModuleEntitlementService.name);

  /** Short enough that a plan change is not confusing, long enough to matter under load. */
  private static readonly TTL_MS = 15_000;

  private readonly cache = new Map<string, { modules: Set<string> | null; readAt: number }>();

  /**
   * The modules this company may use, or `null` when it is not on a plan at all.
   *
   * Withheld beats extra, which is the same rule the Master Console and the provisioning wizard
   * apply — three surfaces disagreeing about what a company can see would be worse than any one
   * of them being wrong.
   */
  async modulesFor(tenantId: string): Promise<Set<string> | null> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.readAt < ModuleEntitlementService.TTL_MS) {
      return cached.modules;
    }

    const modules = await this.read(tenantId);
    this.cache.set(tenantId, { modules, readAt: Date.now() });
    return modules;
  }

  /** Drop a company's cached answer, so a plan change shows immediately rather than in `TTL_MS`. */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async read(tenantId: string): Promise<Set<string> | null> {
    const subscription = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.findFirst({
        where: { tenantId },
        select: {
          extraModules: true,
          removedModules: true,
          plan: { select: { entitledModules: true } },
        },
      }),
    );

    if (subscription === null) return null;

    const effective = new Set<string>([
      ...subscription.plan.entitledModules,
      ...subscription.extraModules,
    ]);
    for (const removed of subscription.removedModules) effective.delete(removed);

    return effective;
  }

  constructor(private readonly prisma: PrismaService) {}

  /** What to tell somebody who reached a module their company is not paying for. */
  static refusalFor(module: CompanyModuleKey | string): string {
    return (
      `Your company's plan does not include ${module}. An administrator can add it from ` +
      'Settings → Billing, or ask UBoss to change the plan.'
    );
  }
}
