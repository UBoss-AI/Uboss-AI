import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { BLIND_INDEX_PURPOSES, SecretBox } from '../auth/secret-box.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { generateUbossUniqueId } from '../persistence/uboss-unique-id.js';
import { AADHAAR_REJECTION_MESSAGES, normaliseAadhaar } from './aadhaar.js';

export interface PersonMatchResult {
  userId: string;
  /** The permanent identifier that follows this person across companies. */
  ubossUniqueId: string;
  /** True when an existing UBoss person was recognised rather than created. */
  matched: boolean;
  /** Which signal matched, for the progress UI. Null when nothing matched. */
  matchedOn: 'AadhaarEnteredOnly' | 'WorkEmail' | null;
  /** The masked fragment, and the only form of the identifier that exists anywhere. */
  aadhaarMasked: string | null;
}

/**
 * The Global Person Registry: match an entered person to one permanent UBoss identity, or create
 * one.
 *
 * ## Why `User` is the global person
 *
 * The prompt pack asks for a `global_person` model. `User` already is exactly that — one row per
 * human, platform-plane, carrying `ubossUniqueId`, the permanent cross-company identifier — and
 * provisioning has reused it across companies since Prompt 10. Adding a second table would
 * create two competing answers to "who is this human", and every later feature would have to
 * pick one. So the registry is built *on* `User`, with `person_identifiers` as the new matching
 * layer and `employment_records` as the per-company employment. Recorded as ADR-062, with the
 * naming difference stated rather than hidden.
 *
 * ## What Aadhaar is here, and what it is not
 *
 * It is a **match input, entered only**. There is no OTP, no authentication, no verification,
 * and no state anywhere in the system that can express "verified Aadhaar" — the
 * `IdentifierAssurance` enum has two values and neither of them is `Verified`.
 *
 * The number itself is **never stored**. What is stored is a keyed HMAC (the match key) and the
 * last four digits (the only fragment ever displayed). The database rejects anything but a
 * 64-hex digest in the hash column, so this is not a promise about code discipline.
 *
 * **Aadhaar is not the UBoss Unique ID** and is never the cross-company search key.
 * `ubossUniqueId` is, and it is generated independently of any personal identifier.
 *
 * ## What a matching company learns
 *
 * That one UBoss identity already exists, and that person's permanent ID. **Not** where else
 * they work, not their other employment records, not who entered the identifier before. That
 * boundary is the difference between a portable professional identity and a background-check
 * service, and it is enforced by the repository returning a decision rather than rows.
 */
@Injectable()
export class PersonRegistryService {
  private readonly logger = new Logger(PersonRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    // `AuthModule` is global and provides `SecretBox` under its own class token.
    private readonly secrets: SecretBox,
  ) {}

  /**
   * Match or create the person behind an Add Employee submission.
   *
   * Must run **inside the caller's transaction**: the person, their identifier, their membership
   * and their employment record either all exist or none do. A person created for an employment
   * record that then failed validation would be a permanent orphan carrying a permanent ID.
   */
  async matchOrCreateWithinCurrentScope(input: {
    tenantId: string;
    actorUserId: string;
    employeeName: string;
    /** Raw as typed, with or without separators. Never stored. */
    aadhaarNumber: string;
    /** Optional secondary signal. */
    workEmail?: string | undefined;
  }): Promise<PersonMatchResult> {
    const normalisation = normaliseAadhaar(input.aadhaarNumber);
    if (!normalisation.ok) {
      throw new BadRequestException(AADHAAR_REJECTION_MESSAGES[normalisation.reason]);
    }

    const { normalised, lastFour } = normalisation.value;
    const index = this.secrets.blindIndex(normalised, BLIND_INDEX_PURPOSES.aadhaarMatch);

    const existing = await this.organization.findPersonByIdentifierWithinCurrentScope({
      kind: 'AadhaarEnteredOnly',
      matchHash: index.hash,
    });

    if (existing) {
      // A person UBoss already knows. Their permanent ID is reused — that is the whole point of
      // a portable identity, and it is what makes prior professional history findable by
      // UBoss Unique ID later.
      await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: 'person.matched_existing',
        resourceType: 'user',
        resourceId: existing.userId,
        resourceRef: existing.ubossUniqueId,
        actorUserId: input.actorUserId,
        summary: `Matched an existing UBoss person by entered identifier.`,
        metadata: {
          matchedOn: 'AadhaarEnteredOnly',
          // Recorded on the event so an auditor reading the trail sees the claim UBoss makes,
          // and the one it does not.
          aadhaarAssurance: 'EnteredOnly',
          aadhaarVerified: false,
        },
      });

      return {
        userId: existing.userId,
        ubossUniqueId: existing.ubossUniqueId,
        matched: true,
        matchedOn: 'AadhaarEnteredOnly',
        aadhaarMasked: `XXXX XXXX ${lastFour}`,
      };
    }

    // Nothing matched: a new permanent UBoss identity.
    //
    // The email is synthesised from the UBoss Unique ID when the company did not supply one,
    // because `users.email` is a unique login handle and this person may have no work address
    // yet — they are in the org chart before they are invited, which is the normal order. It is
    // a placeholder that cannot receive mail and cannot collide, and the invitation flow
    // replaces it when a real address arrives.
    const ubossUniqueId = generateUbossUniqueId();
    const email = input.workEmail?.trim()
      ? input.workEmail.trim().toLowerCase()
      : `${ubossUniqueId.toLowerCase()}@person.uboss.invalid`;

    const person = await this.prisma.client.user.create({
      data: {
        ubossUniqueId,
        email,
        displayName: input.employeeName.trim(),
      },
    });

    await this.organization.attachIdentifierWithinCurrentScope({
      userId: person.id,
      kind: 'AadhaarEnteredOnly',
      matchHash: index.hash,
      matchKeyId: index.keyId,
      lastFour,
      enteredByTenantId: input.tenantId,
      enteredByUserId: input.actorUserId,
    });

    await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
      action: 'person.created',
      resourceType: 'user',
      resourceId: person.id,
      resourceRef: ubossUniqueId,
      actorUserId: input.actorUserId,
      summary: 'Created a new permanent UBoss person; no existing identity matched.',
      metadata: {
        matchedOn: null,
        aadhaarAssurance: 'EnteredOnly',
        aadhaarVerified: false,
        // Stated so the trail answers the question directly rather than by omission.
        aadhaarStored: false,
      },
    });

    // A new permanent identity is a security-relevant event: it is the creation of an identifier
    // that will follow a real person across employers, and it happened because one company's
    // administrator typed a number.
    await this.securityEvents.recordWithinCurrentScope({
      action: SECURITY_ACTIONS.personIdentityCreated,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      subjectUserId: person.id,
      resourceType: 'user',
      resourceId: person.id,
      summary: `New permanent UBoss identity ${ubossUniqueId} created from an entered identifier.`,
      metadata: { assurance: 'EnteredOnly', verified: false },
    });

    return {
      userId: person.id,
      ubossUniqueId,
      matched: false,
      matchedOn: null,
      aadhaarMasked: `XXXX XXXX ${lastFour}`,
    };
  }
}
