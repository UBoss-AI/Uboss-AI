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
      if (existing.isPlatformActor && role && credential) {
        /*
         * The owner exists, so the password in the environment is ignored — which is correct by
         * default and was a trap the first time it mattered.
         *
         * Changing `UBOSS_INITIAL_ADMIN_PASSWORD` and redeploying did nothing at all: this
         * branch returned "already configured" and the person was left locked out of the only
         * console account, with no reset mail (`/login/reset` was a 404) and no other way in.
         * Silently honouring a changed password instead would be worse — every redeploy would
         * reset the owner's password to whatever a secret last said, undoing any change they had
         * made themselves.
         *
         * So it is explicit. `UBOSS_INITIAL_ADMIN_PASSWORD_RESET=true` says "I mean it", once.
         * Set it, deploy, sign in, remove it. Leaving it on resets the password on every restart,
         * which the log below says in as many words.
         */
        if ((process.env['UBOSS_INITIAL_ADMIN_PASSWORD_RESET'] ?? '').trim() !== 'true') {
          return 'already-configured';
        }

        await credentials.setPassword(existing.id, passwordHash, new Date());
        // A lockout outlives a password change otherwise, so somebody who reset *because* they
        // were locked out would still be locked out.
        await credentials.clearFailures(existing.id);

        await audit.appendAuditEvent({
          tenantId: null,
          action: 'platform_owner.password_reset',
          resourceType: 'user',
          resourceId: existing.id,
          summary: 'Reset the Platform Owner password from the deployment environment.',
          reason: 'UBOSS_INITIAL_ADMIN_PASSWORD_RESET was set for this deployment.',
          metadata: { bootstrap: true },
        });

        return 'password-reset';
      }
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

  if (outcome === 'created') {
    console.log('Initial platform owner created.');
  } else if (outcome === 'password-reset') {
    console.log(
      'Platform owner password RESET from UBOSS_INITIAL_ADMIN_PASSWORD, and any lockout cleared.',
    );
    console.log(
      'Remove UBOSS_INITIAL_ADMIN_PASSWORD_RESET now: left set, this resets the password on ' +
        'every restart and will undo any change made from inside the product.',
    );
  } else {
    console.log('Initial platform owner already exists.');
  }
} finally {
  await prisma.onModuleDestroy();
}
