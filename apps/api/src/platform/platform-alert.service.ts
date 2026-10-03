import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../persistence/prisma.service.js';

/** How long to wait on the webhook before giving up. An alert must not hold a caller. */
const WEBHOOK_TIMEOUT_MS = 5_000;

export interface RaiseAlertInput {
  /** Which part of the platform. Matches the existing rows: `scheduler`, `model-gateway`, … */
  service: string;
  severity: 'Info' | 'Warning' | 'Critical';
  /** One line. Part of the deduplication key, so it must describe the *class* of failure. */
  summary: string;
  detail: string;
  /** The company this concerns, when it concerns one. */
  affectedTenantId?: string | null | undefined;
}

/**
 * Raises a service alert, and tells somebody.
 *
 * ## What was missing
 *
 * `service_alerts` was a table somebody reads. Nothing outside the seed ever wrote to it, and
 * nothing told anybody when a row appeared — so the Master Console's "open incidents" tile
 * counted demo data, and a real failure would have waited for a person to open the screen and
 * notice. A monitoring system nobody is paged by is a report.
 *
 * ## A webhook, not a mailing list
 *
 * Platform operations already run through something that accepts a POST — Slack, PagerDuty, an
 * on-call bridge. Building a second recipient model here would be a rota nobody maintains, and
 * platform staff belong to no tenant, so the notification engine (which is tenant-scoped) cannot
 * reach them anyway.
 *
 * ## Recording and telling are separate, and failing at one must not lose the other
 *
 * The row is written first and committed regardless of the webhook. An alert that was not
 * recorded because a Slack URL was wrong is the worst outcome available here: the failure is
 * invisible *and* the record of it is gone.
 *
 * ## Deduplicated on (service, summary) while open
 *
 * A provider failing every minute would otherwise open a thousand identical incidents, and the
 * console becomes unreadable at exactly the moment it matters. A partial unique index enforces
 * it, so two API instances racing cannot both create one. A *resolved* alert does not block a new
 * one — the same thing breaking again is news.
 *
 * ## It never throws at its caller
 *
 * Every producer is already handling a failure when it calls this. An alert that threw would turn
 * "the provider is down" into "the provider is down and the request crashed".
 */
@Injectable()
export class PlatformAlertService {
  private readonly logger = new Logger(PlatformAlertService.name);

  constructor(private readonly prisma: PrismaService) {}

  async raise(input: RaiseAlertInput): Promise<{ alertId: string | null; delivered: boolean }> {
    let alertId: string | null = null;

    try {
      alertId = await this.record(input);
    } catch (error) {
      this.logger.error(
        `Could not record a ${input.severity} alert for ${input.service}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The alert was: ${input.summary}`,
      );
      // Still attempt to tell somebody. A failure we cannot write down is the one most worth
      // sending, and the log line above is the fallback record.
    }

    const delivered = await this.notify(input, alertId);
    return { alertId, delivered };
  }

  /** @returns the alert id, or the existing open one's id when this is a repeat. */
  private async record(input: RaiseAlertInput): Promise<string> {
    return this.prisma.runAsPlatformOperation(async () => {
      const open = await this.prisma.client.serviceAlert.findFirst({
        where: { service: input.service, summary: input.summary, state: { not: 'Resolved' } },
        select: { id: true },
      });
      if (open !== null) {
        // Already open. The detail is not overwritten: the first occurrence is the one with the
        // context somebody will investigate, and a hundredth copy of the same message adds
        // nothing but noise to a row people are reading.
        return open.id;
      }

      const created = await this.prisma.client.serviceAlert.create({
        data: {
          service: input.service,
          severity: input.severity,
          state: 'Open',
          summary: input.summary,
          detail: input.detail,
          ...(input.affectedTenantId === undefined || input.affectedTenantId === null
            ? {}
            : { affectedTenantId: input.affectedTenantId }),
        },
        select: { id: true },
      });
      return created.id;
    });
  }

  /** @returns whether somebody was actually told. `false` is the honest answer when nobody was. */
  private async notify(input: RaiseAlertInput, alertId: string | null): Promise<boolean> {
    const url = await this.webhookUrl();
    if (url === null) {
      // Not an error. A deployment may legitimately read alerts from the console, and saying so
      // at `debug` keeps it from looking like a failure in every log.
      this.logger.debug(
        `No operations.alert_webhook_url, so nobody was told about: ${input.summary}`,
      );
      return false;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // `text` first, because Slack's incoming webhooks read that field and ignore the rest.
          // A payload that works out of the box with the most common destination is worth the
          // duplication; everything structured is here too, for anything that parses it.
          text: `[${input.severity}] ${input.service}: ${input.summary}\n${input.detail}`,
          alertId,
          service: input.service,
          severity: input.severity,
          summary: input.summary,
          detail: input.detail,
          affectedTenantId: input.affectedTenantId ?? null,
          raisedAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `The alert webhook answered ${response.status} for: ${input.summary}. ` +
            'The alert is recorded and visible in the console.',
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not reach the alert webhook: ${error instanceof Error ? error.message : String(error)}. ` +
          'The alert is recorded and visible in the console.',
      );
      return false;
    }
  }

  private async webhookUrl(): Promise<string | null> {
    try {
      const row = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.platformSetting.findUnique({
          where: { key: 'operations.alert_webhook_url' },
          select: { value: true },
        }),
      );
      const url = typeof row?.value === 'string' ? row.value.trim() : '';
      // Only http(s). A setting is platform-operator input, and `file:` or `gopher:` reaching
      // `fetch` from a server process is the shape of a request-forgery bug.
      if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
      return url;
    } catch {
      return null;
    }
  }
}
