import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { TenantScope } from './tenant-context.js';

/**
 * The client available inside an interactive transaction. Repositories are written against this
 * type, so the same method works whether or not it is running in a transaction.
 *
 * Derived from Prisma's own `$transaction` callback parameter rather than hand-listing the
 * excluded methods, so it cannot drift when Prisma changes that surface.
 */
export type PrismaTransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Which RLS scope has been declared to PostgreSQL for the current transaction.
 *
 * A path with no declared scope reads zero rows from the tenant-owned tables — RLS fails
 * closed, so forgetting to declare a scope is an immediate visible failure rather than a leak.
 */
export type DeclaredScope = { kind: 'tenant'; tenantId: string } | { kind: 'platform' };

/**
 * Prisma access plus the transaction convention for the whole API.
 *
 * ## Transaction convention
 *
 * Repositories never call `$transaction` themselves and never take a transaction parameter.
 * They call `this.prisma.client` (via `PrismaService.client`), which returns the ambient
 * transaction when one is open and the root client otherwise. A service opens a transaction
 * with `runInTransaction`, and every repository call inside that callback — however deep —
 * automatically joins it.
 *
 * This is implemented with `AsyncLocalStorage` rather than by threading a `tx` argument
 * through every signature, because a forgotten argument silently writes outside the
 * transaction and that failure is invisible in review.
 *
 * Rules:
 *  - A service method that writes more than one row MUST wrap the writes in
 *    `runInTransaction`, so a partial write cannot be left behind.
 *  - An audit event is written in the same transaction as the change it records: if the change
 *    rolls back, so does its audit row.
 *  - Do not perform network calls inside a transaction — it holds a database connection.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly root: PrismaClient;
  private readonly transactionStore = new AsyncLocalStorage<PrismaTransactionClient>();
  private readonly scopeStore = new AsyncLocalStorage<DeclaredScope>();

  /**
   * @param poolMax Maximum pooled connections. Omitted in the application, which takes the
   *   driver's default. The test harness sets it explicitly because that default of ten is too
   *   small for what this codebase does concurrently: `AuthorizationService.contextFor` opens
   *   five transactions at once on every authorized request, and one suite fires twelve
   *   concurrent appends. Running out surfaces as "Unable to start a transaction in the given
   *   time" in whichever suite happened to be running — never as anything naming a pool, which
   *   is what made it look like a flaky test for several prompts.
   *
   *   **A bigger pool is not safer.** Measured, not assumed: the same spec passes twice at 20 and
   *   fails at 40. Prisma allows two seconds to acquire a transaction, and with a larger ceiling
   *   the driver opens *cold* connections under a burst rather than reusing warm ones — on a
   *   Docker Desktop Postgres, establishing one can eat that budget. Deliberately no
   *   `idleTimeoutMillis` either, for the same reason: discarding a warm connection that will be
   *   wanted seconds later trades a cheap reuse for an expensive handshake.
   */
  constructor(connectionString?: string, poolMax?: number) {
    const url = connectionString ?? process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Start the local database with ' +
          '`docker compose -f infra/docker-compose.yml up -d` and copy apps/api/.env.example to .env.',
      );
    }

    // Prisma 7 requires a driver adapter; there is no Rust engine and no connection string in
    // the schema file.
    this.root = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        ...(poolMax === undefined ? {} : { max: poolMax }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.root.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.root.$disconnect();
  }

  /**
   * The client repositories must use: the ambient transaction if one is open, else the root
   * client.
   */
  get client(): PrismaTransactionClient {
    return this.transactionStore.getStore() ?? this.root;
  }

  /** True while executing inside `runInTransaction`. */
  get inTransaction(): boolean {
    return this.transactionStore.getStore() !== undefined;
  }

  /**
   * Run `work` in a single database transaction. Nested calls join the outer transaction
   * rather than opening a second one, so a service can compose other services safely.
   *
   * Note: this declares no RLS scope. Under Row-Level Security the tenant-owned tables will
   * return zero rows inside it. Use `runInTenantTransaction` or `runAsPlatformOperation`
   * for anything touching `tenant_memberships` or `audit_events`.
   */
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const existing = this.transactionStore.getStore();
    if (existing) {
      return work();
    }

    return this.root.$transaction(async (tx) => {
      return this.transactionStore.run(tx as PrismaTransactionClient, work);
    });
  }

  /**
   * Run `work` in a transaction scoped to one tenant, declaring that scope to PostgreSQL so
   * Row-Level Security enforces it as a second layer.
   *
   * `SET LOCAL` is used rather than `SET`: the value is scoped to this transaction and is
   * discarded on commit or rollback, so a pooled connection can never carry one tenant's scope
   * into another tenant's request.
   *
   * A nested call must not silently widen or change the scope, so re-entering with a different
   * tenant is rejected rather than ignored.
   */
  async runInTenantTransaction<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    const active = this.scopeStore.getStore();
    if (active) {
      if (active.kind === 'tenant' && active.tenantId !== scope.tenantId) {
        throw new Error(
          `Refusing to nest a tenant transaction for ${scope.tenantId} inside one for ` +
            `${active.tenantId}. Cross-tenant work must be an explicit platform operation.`,
        );
      }
      return work();
    }

    return this.root.$transaction(async (tx) => {
      const client = tx as PrismaTransactionClient;
      await client.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${scope.tenantId}'`);

      return this.scopeStore.run({ kind: 'tenant', tenantId: scope.tenantId }, () =>
        this.transactionStore.run(client, work),
      );
    });
  }

  /**
   * Run `work` as a deliberate platform-plane operation — provisioning, Master Console reads,
   * seeds, migrations — declaring to PostgreSQL that it may legitimately cross tenants.
   *
   * **Never call this from a tenant-scoped request path.** Doing so disables the RLS backstop
   * for that request. The name is verbose on purpose: it should look wrong in a company
   * workspace handler.
   */
  async runAsPlatformOperation<T>(work: () => Promise<T>): Promise<T> {
    const active = this.scopeStore.getStore();
    if (active) {
      if (active.kind === 'tenant') {
        throw new Error(
          'Refusing to escalate a tenant-scoped transaction to a platform operation. ' +
            'Restructure the caller so the platform work happens outside the tenant scope.',
        );
      }
      return work();
    }

    return this.root.$transaction(async (tx) => {
      const client = tx as PrismaTransactionClient;
      await client.$executeRawUnsafe(`SET LOCAL app.platform_operation = 'on'`);

      return this.scopeStore.run({ kind: 'platform' }, () =>
        this.transactionStore.run(client, work),
      );
    });
  }

  /** The RLS scope currently declared to PostgreSQL, if any. Exposed for tests and diagnostics. */
  get declaredScope(): DeclaredScope | undefined {
    return this.scopeStore.getStore();
  }

  /** Escape hatch for migrations, seeds and tests that legitimately need the root client. */
  get unsafeRootClient(): PrismaClient {
    return this.root;
  }
}
