import type { PrismaService } from '../persistence/prisma.service.js';

/**
 * Who to tell, when the thing to be told is the company's own commercial position.
 *
 * ## Why this is a function and not an injectable
 *
 * Two callers need it — the budget alerts and the subscription notices — and both already have a
 * `PrismaService`. Making it a provider would add a constructor argument to each of them, and
 * several specs in this codebase assemble their modules by hand: a third argument on a service is
 * how a test file starts failing with "Nest can't resolve dependencies" for a change that had
 * nothing to do with it. A plain function has no such reach.
 *
 * ## Why it was extracted
 *
 * It lived privately inside `BudgetAlertService`. The subscription notice needs exactly the same
 * answer, and a second copy of "which people may act on money here" is the kind of duplicate that
 * drifts quietly: the day somebody adds a second administering role, one alert reaches them and
 * the other does not, and nobody finds out until a company is not told its workspace stopped.
 */
export async function companyAdminUserIds(
  prisma: PrismaService,
  tenantId: string,
): Promise<string[]> {
  const assignments = await prisma.runAsPlatformOperation(() =>
    prisma.client.roleAssignment.findMany({
      where: { tenantId, roleKind: 'CompanyAdmin' },
      select: { userId: true },
    }),
  );

  if (assignments.length === 0) return [];

  const active = await prisma.runAsPlatformOperation(() =>
    prisma.client.tenantMembership.findMany({
      where: {
        tenantId,
        userId: { in: assignments.map((row) => row.userId) },
        /*
         * Active memberships only.
         *
         * Telling somebody who has been offboarded about a company they can no longer reach is
         * noise at best, and at worst it is this product sending a former employee a notice about
         * their old employer's unpaid bill.
         */
        accountState: 'Active',
      },
      select: { userId: true },
    }),
  );

  return [...new Set(active.map((row) => row.userId))];
}
