import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { SECRET_PURPOSES, SecretBox } from '../auth/secret-box.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * The Secrets Manager seam.
 *
 * ## Why an adapter and not a column
 *
 * The client's rule is `secret_ref` only: a connection stores a **handle**, and the value lives
 * wherever the deployment keeps secrets. An interface makes that structural — nothing above this
 * line has a method that returns a credential to a screen, and swapping in AWS Secrets Manager or
 * Vault changes one provider binding.
 *
 * ## What every implementation must guarantee
 *
 * 1. `put` returns a handle that is **not derived from the value**. A deterministic handle would
 *    make the reference itself a probe: anybody who could guess a credential could confirm it.
 * 2. `reveal` is the *only* way to get plaintext, it is never reachable from a read path, and it
 *    is audited by its caller.
 * 3. A handle is scoped to one company. A reference from one tenant must not resolve in another,
 *    however the underlying store is organised.
 */
export abstract class SecretsVault {
  /** Store a value and return its handle. */
  abstract put(scope: TenantScope, value: string): Promise<string>;

  /** Replace the value behind an existing handle, keeping the handle. */
  abstract rotate(scope: TenantScope, secretRef: string, value: string): Promise<void>;

  /**
   * The plaintext. **The only method that returns one.**
   *
   * Called by a connector adapter at the moment of use, never by a controller, and never to
   * populate a form — a credential that has been shown once is a credential in a browser's
   * memory, and every connection screen in UBoss shows the handle instead.
   */
  abstract reveal(scope: TenantScope, secretRef: string): Promise<string>;

  /** Whether a handle resolves. For *Test Connection* to fail usefully rather than throw. */
  abstract exists(scope: TenantScope, secretRef: string): Promise<boolean>;

  /** Forget a value. The connection row survives; the credential does not. */
  abstract forget(scope: TenantScope, secretRef: string): Promise<void>;

  /** What this vault is, for the operational view. Never a claim about a provider it is not. */
  abstract describe(): { name: string; isExternalProvider: boolean; note: string };
}

export class SecretNotFoundError extends Error {
  constructor(secretRef: string) {
    super(
      `No secret is stored for ${secretRef}. The connection needs reauthorizing before it can ` +
        'be used.',
    );
  }
}

/**
 * The default vault: **the local `connection_secrets` table, sealed with `SecretBox`.**
 *
 * ## Why this is the default rather than a cloud provider
 *
 * There is no verified external secrets provider for this deployment, and a binding that quietly
 * pointed at one would fail in a way that looks like a credential problem. So the default is
 * honest and self-contained: AES-256-GCM through the existing `SecretBox` (the same primitive
 * behind TOTP secrets and SSO client secrets since Prompt 6), keyed, versioned, with the key id
 * recorded so a key rotation can find what needs resealing.
 *
 * `describe()` reports `isExternalProvider: false`, and the operational view says so — "encrypted
 * at rest in our own database" is a real guarantee, and it is a different one from "held in a
 * managed secrets service".
 *
 * ## Why the handle is random
 *
 * `cs_` plus 24 random bytes. A handle derived from the connection id would leak which connection
 * a secret belongs to across a boundary the vault interface is meant to hide, and one derived
 * from the value would let anybody who could guess a credential confirm it by looking for its
 * handle.
 */
@Injectable()
export class LocalSealedSecretsVault extends SecretsVault {
  private readonly logger = new Logger('SecretsVault');

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
  ) {
    super();
  }

  async put(scope: TenantScope, value: string): Promise<string> {
    if (value.trim() === '') {
      throw new Error('A connection secret cannot be empty.');
    }

    const secretRef = `cs_${randomBytes(24).toString('base64url')}`;
    const sealed = this.secrets.seal(value, SECRET_PURPOSES.connectionSecret);

    await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionSecret.create({
        data: {
          tenantId: scope.tenantId,
          secretRef,
          sealedValue: sealed,
          keyId: this.secrets.keyIdOf(sealed) ?? 'unknown',
        },
      }),
    );

    // The handle, never the value, and never a length — a length is a hint.
    this.logger.log(`Stored a connection secret as ${secretRef}.`);
    return secretRef;
  }

  async rotate(scope: TenantScope, secretRef: string, value: string): Promise<void> {
    if (value.trim() === '') {
      throw new Error('A connection secret cannot be empty.');
    }

    const sealed = this.secrets.seal(value, SECRET_PURPOSES.connectionSecret);

    await this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.connectionSecret.findFirst({
        where: { tenantId: scope.tenantId, secretRef },
      });
      if (!existing) {
        throw new SecretNotFoundError(secretRef);
      }

      await this.prisma.client.connectionSecret.update({
        where: { id: existing.id },
        data: {
          sealedValue: sealed,
          keyId: this.secrets.keyIdOf(sealed) ?? 'unknown',
          // Distinct from `updatedAt`, which any write moves. This is "when the credential
          // itself last changed", which is what a rotation policy asks about.
          rotatedAt: new Date(),
        },
      });
    });
  }

  async reveal(scope: TenantScope, secretRef: string): Promise<string> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionSecret.findFirst({
        where: { tenantId: scope.tenantId, secretRef },
      }),
    );

    if (!row) {
      throw new SecretNotFoundError(secretRef);
    }

    return this.secrets.open(row.sealedValue, SECRET_PURPOSES.connectionSecret);
  }

  async exists(scope: TenantScope, secretRef: string): Promise<boolean> {
    const count = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionSecret.count({
        where: { tenantId: scope.tenantId, secretRef },
      }),
    );
    return count > 0;
  }

  async forget(scope: TenantScope, secretRef: string): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionSecret.deleteMany({
        where: { tenantId: scope.tenantId, secretRef },
      }),
    );
  }

  describe(): { name: string; isExternalProvider: boolean; note: string } {
    return {
      name: 'Local sealed store',
      isExternalProvider: false,
      note:
        'Secrets are encrypted at rest with AES-256-GCM in this deployment’s own database, ' +
        'keyed and versioned. That is a real guarantee, and it is a different one from being ' +
        'held in a managed secrets service — no external provider is configured.',
    };
  }
}
