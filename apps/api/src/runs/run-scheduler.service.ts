import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_MISSED_RUN_POLICY,
  DEFAULT_WORKING_DAYS,
  isWorkingMoment,
  nextWorkingMoment,
  WEEKDAYS,
  type BusinessCalendar,
  type MissedRunPolicy,
  type Weekday,
} from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import { CompanySettingsService } from '../settings/company-settings.service.js';
import { RunEngineService } from './run-engine.service.js';

/** What one scheduler tick did, per agent. */
export interface SchedulerOutcome {
  engineAgentId: string;
  agentName: string;
  started: number;
  skipped: number;
  reason: string;
}

/**
 * The scheduler — Prompt 26.
 *
 * ## One tick, idempotent, safe on two instances
 *
 * A tick works out which occurrences were due, and asks the run engine to start each one with the
 * *due instant* as its idempotency occurrence. Two instances ticking at once therefore compute
 * identical keys, and the unique index makes the second a no-op. Nothing here needs a lock.
 *
 * ## Everything is in the company's timezone
 *
 * "Monday 10:30" means the company's Monday. `general.timezone`, `general.working_days` and
 * `general.holidays` are read per company, and a due moment that lands on a non-working day is
 * not run — it is moved or skipped by the missed-run policy, never silently fired on a Saturday.
 *
 * ## No cron library
 *
 * `schedule_cron` is parsed here, and only the subset a business schedule needs: minute, hour, and
 * day-of-week, with `*` and comma lists. That is a deliberate limit rather than a shortcut — a
 * full cron expression can express "every 7 minutes between 3 and 4 AM on the 13th", which is not
 * a business schedule and would silently bypass the working-day rules this scheduler exists to
 * enforce. An expression outside the subset is refused with its reason rather than approximated.
 */
@Injectable()
export class RunSchedulerService {
  private readonly logger = new Logger(RunSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CompanySettingsService,
    private readonly engine: RunEngineService,
  ) {}

  /**
   * Run one tick for one company.
   *
   * @param now Injectable so a test can place the clock on a Tuesday in a given timezone rather
   *   than waiting for one.
   */
  async tick(input: {
    scope: TenantScope;
    now?: Date | undefined;
  }): Promise<{ outcomes: SchedulerOutcome[]; note: string }> {
    const now = input.now ?? new Date();
    const calendar = await this.calendarFor(input.scope);

    const agents = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.engineAgent.findMany({
        where: {
          tenantId: input.scope.tenantId,
          status: 'Active',
          scheduleCron: { not: null },
        },
      }),
    );

    const outcomes: SchedulerOutcome[] = [];

    for (const agent of agents) {
      // Sequential: each of these opens its own transaction, and concurrent work inside a tenant
      // transaction loses the AsyncLocalStorage scope, which silently unscopes the reads.
      outcomes.push(await this.tickAgent({ scope: input.scope, agent, calendar, now }));
    }

    return {
      outcomes,
      note:
        'Every occurrence is keyed by its due instant, so two schedulers ticking at once cannot ' +
        'double-start it. A due moment on a non-working day is never silently fired.',
    };
  }

  /** The company's calendar, from settings, with the safe defaults where nothing is set. */
  async calendarFor(scope: TenantScope): Promise<BusinessCalendar> {
    const timezone = String(
      (await this.settings.effectiveValue(scope, 'general.timezone')) ?? 'Asia/Kolkata',
    );
    const workingDaysRaw = String(
      (await this.settings.effectiveValue(scope, 'general.working_days')) ?? '',
    );
    const holidaysRaw = String(
      (await this.settings.effectiveValue(scope, 'general.holidays')) ?? '',
    );

    // Parsed against the closed weekday vocabulary, not trusted. The setting's pattern already
    // constrains the shape; this refuses anything that slipped it rather than treating an
    // unrecognised word as a working day.
    const workingDays = workingDaysRaw
      .split(',')
      .map((day) => day.trim())
      .filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day));

    return {
      timezone,
      workingDays: workingDays.length > 0 ? workingDays : DEFAULT_WORKING_DAYS,
      holidays: holidaysRaw
        .split(',')
        .map((date) => date.trim())
        .filter((date) => date !== ''),
    };
  }

  private async tickAgent(input: {
    scope: TenantScope;
    agent: {
      id: string;
      name: string;
      scheduleCron: string | null;
      nextRunAt: Date | null;
      missedRunPolicy: string | null;
    };
    calendar: BusinessCalendar;
    now: Date;
  }): Promise<SchedulerOutcome> {
    const { agent, calendar, now } = input;
    const base: SchedulerOutcome = {
      engineAgentId: agent.id,
      agentName: agent.name,
      started: 0,
      skipped: 0,
      reason: '',
    };

    const parsed = parseBusinessCron(agent.scheduleCron ?? '');
    if (!parsed.ok) {
      // Reported, not guessed at. An unparseable schedule that quietly never fires is the worst
      // outcome: the company believes an agent is running and it is not.
      return { ...base, reason: `The schedule could not be read: ${parsed.reason}` };
    }

    const policy = (agent.missedRunPolicy ??
      (await this.settings.effectiveValue(input.scope, 'runs.missed_run_policy')) ??
      DEFAULT_MISSED_RUN_POLICY) as MissedRunPolicy;

    // Occurrences from the last checkpoint to now. `nextRunAt` is the checkpoint; on the first
    // tick there is none, so only the current minute is considered — starting a year of history
    // because an agent was just activated would be indefensible.
    const from = agent.nextRunAt ?? new Date(now.getTime() - 60_000);
    const due = occurrencesBetween(parsed.schedule, from, now, calendar);

    if (due.length === 0) {
      await this.recordNext({
        scope: input.scope,
        agentId: agent.id,
        schedule: parsed.schedule,
        now,
        calendar,
      });
      return { ...base, reason: 'Nothing due.' };
    }

    const toRun = this.applyMissedRunPolicy(due, policy, now);
    let started = 0;

    for (const moment of toRun) {
      try {
        const outcome = await this.engine.start({
          scope: input.scope,
          engineAgentId: agent.id,
          trigger: 'Scheduled',
          // The due instant is the occurrence, which is what makes this idempotent.
          occurrence: moment.toISOString(),
          scheduledFor: moment,
        });
        if (outcome.created) started += 1;
      } catch (caught) {
        // An overlap refusal is an ordinary outcome, not a tick failure. Logged and counted.
        this.logger.log(
          `Agent ${agent.name} did not start its ${moment.toISOString()} occurrence: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    }

    await this.recordNext({
      scope: input.scope,
      agentId: agent.id,
      schedule: parsed.schedule,
      now,
      calendar,
    });

    return {
      ...base,
      started,
      skipped: due.length - toRun.length,
      reason:
        `${due.length} occurrence(s) due, ${toRun.length} eligible under the ${policy} missed-run ` +
        `policy, ${started} started.`,
    };
  }

  /**
   * The missed-run policy, applied to occurrences that are already late.
   *
   * The current occurrence always runs; the policy only governs the ones whose moment has passed.
   * `RunAll` is offered because some work genuinely must not skip a day — a reconciliation, for
   * instance — but it is not the default, because catching up after an outage can flood a
   * provider and spend a budget in minutes.
   */
  private applyMissedRunPolicy(due: Date[], policy: MissedRunPolicy, now: Date): Date[] {
    if (due.length <= 1) return due;

    const sorted = [...due].sort((left, right) => left.getTime() - right.getTime());
    const current = sorted[sorted.length - 1];
    if (current === undefined) return [];

    switch (policy) {
      case 'RunAll':
        return sorted;
      case 'RunOnce':
        // One catch-up: the most recent missed occurrence, which is the one whose result is still
        // worth having.
        return [current];
      case 'Skip':
      default:
        // Only what is due right now. A moment more than a minute old was missed.
        return now.getTime() - current.getTime() <= 60_000 ? [current] : [];
    }
  }

  private async recordNext(input: {
    scope: TenantScope;
    agentId: string;
    schedule: BusinessSchedule;
    now: Date;
    calendar: BusinessCalendar;
  }): Promise<void> {
    const next = nextOccurrenceAfter(input.schedule, input.now, input.calendar);
    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.engineAgent.update({
        where: { id: input.agentId },
        data: { nextRunAt: next },
      }),
    );
  }

  /** One tick across every active company. The platform-plane entry point for a timer. */
  async tickAllCompanies(now?: Date): Promise<{ companies: number; started: number }> {
    const tenants = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenant.findMany({
        where: { lifecycleState: 'Active' },
        select: { id: true },
      }),
    );

    let started = 0;
    for (const tenant of tenants) {
      const result = await this.tick({
        scope: tenantScopeForPlatformOperation(tenant.id),
        ...(now === undefined ? {} : { now }),
      });
      started += result.outcomes.reduce((total, outcome) => total + outcome.started, 0);
    }

    return { companies: tenants.length, started };
  }
}

// ---------------------------------------------------------------------------
// The business cron subset
// ---------------------------------------------------------------------------

/** Minute, hour and weekday — the three fields a business schedule actually needs. */
export interface BusinessSchedule {
  minutes: number[];
  hours: number[];
  /** Empty means every working day, subject to the company calendar. */
  weekdays: Weekday[];
}

/**
 * Parse the supported subset: `minute hour * * day-of-week`.
 *
 * Supports `*` and comma lists in each field. Day-of-week accepts `0-6` (Sunday first) or the day
 * names. Steps (`*&#47;5`), ranges (`1-5`) and day-of-month are refused with a reason rather than
 * approximated — an approximated schedule is one nobody can predict, and this is the code that
 * decides when a company's work happens.
 */
export function parseBusinessCron(
  expression: string,
): { ok: true; schedule: BusinessSchedule } | { ok: false; reason: string } {
  const trimmed = expression.trim();
  if (trimmed === '') return { ok: false, reason: 'it is empty' };

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `a cron expression has five fields; this has ${fields.length}`,
    };
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (domField !== '*' || monthField !== '*') {
    return {
      ok: false,
      reason:
        'day-of-month and month must be * — a business schedule is a time on a weekday, and ' +
        'anything else would bypass the working-day and holiday rules',
    };
  }

  const minutes = parseNumberField(minuteField, 0, 59);
  if (!minutes) return { ok: false, reason: `"${minuteField}" is not a minute or list of minutes` };

  const hours = parseNumberField(hourField, 0, 23);
  if (!hours) return { ok: false, reason: `"${hourField}" is not an hour or list of hours` };

  if (dowField === '*') {
    return { ok: true, schedule: { minutes, hours, weekdays: [] } };
  }

  const weekdays: Weekday[] = [];
  for (const part of dowField.split(',').map((value) => value.trim())) {
    const asNumber = Number(part);
    if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 6) {
      const day = WEEKDAYS[asNumber];
      if (day) weekdays.push(day);
      continue;
    }
    const named = WEEKDAYS.find((day) => day.toLowerCase() === part.toLowerCase());
    if (!named) return { ok: false, reason: `"${part}" is not a day of the week` };
    weekdays.push(named);
  }

  return { ok: true, schedule: { minutes, hours, weekdays } };
}

function parseNumberField(field: string, min: number, max: number): number[] | null {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }
  const values: number[] = [];
  for (const part of field.split(',')) {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value < min || value > max) return null;
    values.push(value);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

/** Minute-of-day and weekday of an instant, in a timezone. */
function localParts(
  at: Date,
  timezone: string,
): { minute: number; hour: number; weekday: Weekday } {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(at);

  const part = (type: string) => formatted.find((entry) => entry.type === type)?.value ?? '';
  const weekdayName = part('weekday');
  const weekday = WEEKDAYS.find((day) => day === weekdayName);
  if (!weekday) throw new Error(`Unrecognised weekday "${weekdayName}" in "${timezone}".`);

  return { minute: Number(part('minute')), hour: Number(part('hour')), weekday };
}

/**
 * Which occurrences fall in `(from, to]`.
 *
 * Walks minute by minute, which is exact and needs no date arithmetic in a named timezone — the
 * thing most schedulers get wrong. Bounded to seven days so a long gap after an outage cannot
 * turn one tick into an unbounded loop; a gap longer than that is reported by the caller rather
 * than silently truncated into a flood of runs.
 */
export function occurrencesBetween(
  schedule: BusinessSchedule,
  from: Date,
  to: Date,
  calendar: BusinessCalendar,
  maxDays = 7,
): Date[] {
  const found: Date[] = [];
  const horizon = Math.min(to.getTime(), from.getTime() + maxDays * 24 * 60 * 60 * 1000);

  // Start at the minute after `from`, aligned to the minute.
  let cursor = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;

  while (cursor <= horizon) {
    const at = new Date(cursor);
    if (matchesSchedule(schedule, at, calendar)) found.push(at);
    cursor += 60_000;
  }

  return found;
}

/** Whether an instant is an occurrence: the cron fields *and* the company calendar. */
export function matchesSchedule(
  schedule: BusinessSchedule,
  at: Date,
  calendar: BusinessCalendar,
): boolean {
  const parts = localParts(at, calendar.timezone);

  if (!schedule.minutes.includes(parts.minute)) return false;
  if (!schedule.hours.includes(parts.hour)) return false;
  if (schedule.weekdays.length > 0 && !schedule.weekdays.includes(parts.weekday)) return false;

  // The calendar has the final say. A schedule that names Saturday explicitly still does not run
  // on a Saturday the company does not work, and never on a holiday — which is the whole point of
  // having a business calendar rather than a raw cron.
  return isWorkingMoment(at, calendar).working;
}

/**
 * The next occurrence strictly after an instant.
 *
 * Bounded to a year. Returns null when nothing matches — a schedule naming a weekday the company
 * does not work, for instance — so the registry can say "this never fires" instead of showing an
 * empty next-run field that looks like a loading state.
 */
export function nextOccurrenceAfter(
  schedule: BusinessSchedule,
  after: Date,
  calendar: BusinessCalendar,
): Date | null {
  if (calendar.workingDays.length === 0) return null;
  // Cheap rejection before the minute walk: if no working day is ever in the schedule's weekday
  // list, nothing can match and a 366-day walk would burn a scheduler tick proving it.
  if (
    schedule.weekdays.length > 0 &&
    !schedule.weekdays.some((day) => calendar.workingDays.includes(day))
  ) {
    return null;
  }
  if (nextWorkingMoment(after, calendar) === null) return null;

  let cursor = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (cursor <= limit) {
    const at = new Date(cursor);
    if (matchesSchedule(schedule, at, calendar)) return at;
    cursor += 60_000;
  }

  return null;
}
