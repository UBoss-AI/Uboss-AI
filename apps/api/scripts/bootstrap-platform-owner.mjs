import { AuditTrailRepository } from '../dist/persistence/audit-trail.repository.js';
import { UserCredentialRepository } from '../dist/persistence/user-credential.repository.js';
import { UserRepository } from '../dist/persistence/user.repository.js';
import { PrismaService } from '../dist/persistence/prisma.service.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { loadAuthConfig } from '../dist/auth/auth.config.js';
import { generateUbossUniqueId } from '../dist/persistence/uboss-unique-id.js';

const email = process.env['UBOSS_INITIAL_ADMIN_EMAIL']?.trim().toLowerCase();
const displayName = process.env['UBOSS_INITIAL_ADMIN_NAME']?.trim();
const password = process.env['UBOSS_INITIAL_ADMIN_PASSWORD'];

if (!email && !displayName && !password) {
  process.exit(0);
}

if (!email || !displayName || !password) {
  throw new Error('Initial admin setup needs email, name, and password together.');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('The initial admin email is not valid.');
}

const prisma = new PrismaService();
const users = new UserRepository(prisma);
const credentials = new UserCredentialRepository(prisma);
const audit = new AuditTrailRepository(prisma);
const passwords = new PasswordService(loadAuthConfig());
passwords.assertAcceptable(password);
const passwordHash = await passwords.hash(password);

try {
  await prisma.onModuleInit();
  const outcome = await prisma.runAsPlatformOperation(async () => {
    const existing = await users.findByEmailForPlatform(email);
    if (existing) {
      const [role, credential] = await Promise.all([
        prisma.client.platformRoleAssignment.findFirst({
          where: { userId: existing.id, role: 'PlatformOwner', revokedAt: null },
          select: { id: true },
        }),
        credentials.findByUserId(existing.id),
      ]);
      if (existing.isPlatformActor && role && credential) return 'already-configured';
      throw new Error(
        'An account with the initial admin email already exists but is not a complete platform owner. Refusing to change it automatically.',
      );
    }

    const owner = await users.createForPlatform({
      ubossUniqueId: generateUbossUniqueId(),
      email,
      displayName,
      isPlatformActor: true,
    });
    await credentials.setPassword(owner.id, passwordHash, new Date());
    const role = await prisma.client.platformRoleAssignment.create({
      data: {
        userId: owner.id,
        role: 'PlatformOwner',
        grantedByUserId: null,
        justification: 'One-time initial production owner bootstrap.',
        updatedAt: new Date(),
      },
      select: { id: true },
    });
    await audit.appendAuditEvent({
      tenantId: null,
      action: 'platform_role_assignment.created',
      resourceType: 'platform_role_assignment',
      resourceId: role.id,
      summary: 'Created the initial production Platform Owner.',
      reason: 'One-time production bootstrap; no prior platform owner existed.',
      metadata: { role: 'PlatformOwner', bootstrap: true },
    });
    return 'created';
  });

  console.log(
    outcome === 'created'
      ? 'Initial platform owner created.'
      : 'Initial platform owner already exists.',
  );
} finally {
  await prisma.onModuleDestroy();
}
