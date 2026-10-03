-- Somebody can sign their own company up, without anybody at UBoss doing anything.
--
-- ## Why a table before a company
--
-- The rule the whole flow is built around: **the company is created last.** A signup has two
-- proofs to clear first — the person controls the email address, and the company controls the
-- domain — and until both are done there is nothing to create a company for.
--
-- Doing it the other way round, which is the obvious way, leaves a tenant row for every abandoned
-- form: an empty company with a half-finished admin, in a database where a company is the unit
-- everything else hangs off. Those rows are indistinguishable from real customers in every count,
-- every report and every seat total, and nobody deletes them because nobody is sure they are safe
-- to delete.
--
-- So the half-finished state lives here, where it is obviously half-finished, and expires on its
-- own.
--
-- ## Why there is no row-level security on it
--
-- There is no tenant yet, so there is nothing to isolate it by. Reaching a row needs the secret
-- token that was emailed, which is the only thing that can produce one — it is not listed, not
-- searchable and not readable by any company. The platform console can read them, which is the
-- point: "how many signups stalled at the DNS step" is a question worth being able to answer.
--
-- ## Why the two tokens are stored differently
--
-- The email token is **hashed**, because it is a bearer credential: whoever has it can complete
-- the email proof, so a leaked database must not hand that over. The domain token is stored in
-- the clear because the company is asked to publish it in public DNS — hashing a value whose
-- whole purpose is to be world-readable would only stop this product from checking it.

CREATE TABLE "pending_registrations" (
  "id" UUID NOT NULL,

  -- What the form collected. Four fields, and no plan: the plan is Pilot, decided by the handler.
  "work_email"   VARCHAR(320) NOT NULL,
  "full_name"    VARCHAR(200) NOT NULL,
  "company_name" VARCHAR(200) NOT NULL,
  "domain"       VARCHAR(253) NOT NULL,

  -- Proof one: the person reads mail at that address. Hashed; see above.
  "email_token_hash"  VARCHAR(100) NOT NULL,
  "email_verified_at" TIMESTAMPTZ(6),

  -- Proof two: the company controls the domain. Published in public DNS, so not hashed.
  "domain_token"       VARCHAR(80) NOT NULL,
  "domain_verified_at" TIMESTAMPTZ(6),

  -- How many times the DNS record has been looked for. Bounded, because each check is a network
  -- call this product makes on an anonymous caller's say-so.
  "domain_checks" INTEGER NOT NULL DEFAULT 0,

  -- From `REGISTRATION_STATES`.
  "state" VARCHAR(30) NOT NULL,

  -- Set when the company is finally created. The link between the signup and what it became.
  "tenant_id" UUID,

  -- Why it stopped, when it stopped for a reason worth telling somebody.
  "failure_reason" VARCHAR(500),

  -- The address the form was submitted from. Kept for abuse investigation and nothing else, and
  -- it goes when the row expires.
  "created_ip" VARCHAR(45),

  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pending_registrations_pkey" PRIMARY KEY ("id"),

  -- A registration that completed has a company, and one that has a company completed. Anything
  -- else is a row that claims to have made something it cannot point at.
  CONSTRAINT "registration_completed_has_a_company"
    CHECK (("state" = 'Completed') = ("tenant_id" IS NOT NULL))
);

-- "Has this person already started one" — the lookup the form does before creating a second.
CREATE INDEX "pending_registrations_work_email_idx"
  ON "pending_registrations" ("work_email");

-- "Is somebody else already claiming this domain" — asked before the DNS step is offered, so two
-- companies do not both spend a day on a record only one of them can win.
CREATE INDEX "pending_registrations_domain_idx"
  ON "pending_registrations" ("domain");

-- The sweeper's query, and the console's "what is stalled" list.
CREATE INDEX "pending_registrations_state_expires_at_idx"
  ON "pending_registrations" ("state", "expires_at");

ALTER TABLE "pending_registrations"
  ADD CONSTRAINT "pending_registrations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_registrations" TO "uboss_app";
