# UX Map

The screen and route inventory for UBoss, plus the state of what is actually built.

The client supplied `index.html` at the repository root as the **exact UI to implement** — not
inspiration. Sections 2–6 below are the inventory taken from it, and they are the specification each
later prompt builds against. `index.html` itself is treated as read-only input (excluded from ESLint
and Prettier) and is never wrapped or served.

---

## 1. What is built

### Prompt 1 — verification only

| Route         | App | Purpose                                                    | States                                                     |
| ------------- | --- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `/`           | web | Bootstrap landing. Not a product screen.                   | success                                                    |
| `/health`     | web | Verification page: web build, API base URL, live API probe | loading, success, degraded, unreachable, contract-mismatch |
| `GET /health` | api | Liveness endpoint                                          | 200, 404 for unknown routes                                |

### Prompt 2 — design system, shells and showcase

| Route                       | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `/design-system`            | Showcase index                                                |
| `/design-system/components` | Every shared primitive with its states, in five tabbed groups |
| `/design-system/company`    | Company Workspace shell + the two-slice dashboard donut       |
| `/design-system/master`     | UBoss Master Console shell (dark platform control plane)      |
| `/design-system/settings`   | Settings shell: left navigation, right detail panel           |
| `/design-system/login`      | Login presentation with the six locked sections               |

These are **shells with mock navigation and no business API calls**. Storybook was not adopted; see
ADR-014. Feature screens, authentication and real data arrive in later prompts.

**Components delivered in `@uboss/ui`** — AppShell, Sidebar, TopBar, Breadcrumbs, PageHeader,
MetricCard, StatusBadge (plus MedalBadge for the badge ladder), DataTable, FilterBar (with
FilterSelect), SearchField, Tabs (with TabPanel), Drawer, Modal, ConfirmDialog, FormField,
EmptyState, ErrorState (with Banner), Skeleton (with SkeletonText), ProgressStep, ApprovalCard,
CreditMeter, SecurityMetric, DonutDashboard, plus Card/CardHeader/CardBody, Icon, `cn()` and
`useFocusTrap()`.

**Behaviour worth knowing:**

- Every state a screen must handle is owned by a component, not repeated per page: `DataTable` has
  loading / empty / error built in, and `ErrorState` covers error, permission-denied, blocked and
  degraded. Permission denial renders as a state with a route onward, never a silent redirect.
- Keyboard support: `Tabs` implements the WAI-ARIA roving-tabindex pattern (arrows, Home/End,
  skipping disabled tabs); overlays trap focus, close on Escape, restore focus on close and lock
  background scroll; clickable table rows are focusable and activate on Enter/Space; the donut's
  drill-downs are real buttons, since SVG arcs alone are unreachable by keyboard.
- Responsive, desktop-first: below 1080px the sidebar becomes an off-canvas drawer opened from the
  top bar, two-column layouts collapse to one, and the login presentation panel is hidden. Below
  720px the top-bar search is hidden. The sidebar also collapses to a 74px icon rail, where labels
  remain the accessible names.
- `prefers-reduced-motion` is honoured globally.
- Status is never colour-only: `StatusBadge` always renders its label, `ProgressStep` adds a
  visually-hidden state word, and `SecurityMetric` adds a visually-hidden level.
- The health page models its outcomes as a discriminated union (`ApiProbe`) rather than null checks,
  so every state is explicit — the same approach feature screens use.

### Prompt 5 — authentication screens

| Route          | Purpose                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `/login`       | Sign in. Workspace picker on success; new-device warning when the sign-in is from a new network |
| `/activate`    | Activate an invitation from its one-time link                                                   |
| `/access-help` | Request a password reset, and complete one from a reset link (two modes, one screen)            |
| `/sessions`    | Active Sessions: every device signed in as you, per-session revoke, Log Out All Devices         |

These are the first screens that call a business API. They use the Prompt 2 design system with no
new one-off styling.

**Behaviour worth knowing:**

- **`/activate` has five states**, not one form: no token, checking, invalid, ready and activated.
  The invalid state is deliberately identical for expired, cancelled and already-used links.
- **`/activate` asks for a password only when the person does not already have one.** Someone
  invited by a second company joins with their existing password — one identity, one password.
- **`/access-help` is two screens in one** because a reset request and a reset completion are two
  halves of one task, and someone arriving from a reset link should not have to work out which page
  they need. The request half always reports the same outcome, whether or not the address has an
  account.
- **No password field anywhere carries a default value.** The UI reference prefills a shared demo
  password in its login form; that is not carried forward (defect 6).
- **The SSO button is rendered disabled**, with a title explaining that enterprise sign-in is
  configured per company. The reference wires it straight into the app; a button that appears to
  authenticate and does not is worse than one that is honestly unavailable.
- **`/sessions` shows a coarse network hint**, not an address, and absolute local timestamps rather
  than "2 hours ago" — a session list is a security record, and "recently" is not actionable.
  Log Out All Devices goes through `ConfirmDialog` with its impact preview, per locked rule G.
- Sign-out is reachable from **both** the sidebar footer and the top bar, matching the reference.

### Prompt 6 — enterprise sign-in

No new routes. The existing screens gained the enterprise steps, because they are steps _in_
signing in rather than separate destinations.

| Route       | What changed                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`    | Email first, then only the methods that company allows; second-factor step; first-time enrolment step; recovery-code display; SSO buttons; a federated-failure banner |
| `/sessions` | Renamed **Login & Security**; gained the two-step sign-in card above the session list                                                                                 |

**Behaviour worth knowing:**

- **Email first.** The screen asks which methods that address's _domain_ allows (debounced, keyed
  on the address so a slow answer cannot overwrite a newer one) and shows only those. Someone at an
  SSO-only company never sees a password field that was never going to be accepted. If the lookup
  fails the password field is shown anyway — the server will accept or refuse on its own terms, so
  a discovery hiccup must not block sign-in.
- **A correct password has three possible answers**, and the screen renders each rather than
  treating any as an error: signed in, second factor needed, or "this company requires SSO". Only
  the first has a session.
- **The password is cleared from component state** the moment the second-factor step begins. It is
  no longer needed and should not sit in memory through the next step.
- **First-time enrolment is part of the sign-in**, not a dead end: the enrolment step shows the
  key, an `otpauth://` link, and a code field, and confirming completes the login. That is what
  makes a newly-imposed MFA policy something a person can act on rather than a lockout.
- **Recovery codes are shown once**, on the screen that generates them, with copy saying so
  plainly — the server keeps hashes, so there is no "show them again" button to look for. The
  two-step card says the same thing, so nobody hunts for a feature that cannot exist.
- **The SSO button is only enabled when that domain has an enabled connection.** A SAML connection
  renders disabled with a title explaining why. Carrying the reference's behaviour forward — where
  the button navigates straight into the app — would be a control that appears to authenticate and
  does not.
- **A failed federated sign-in** returns to `/login?ssoError=…` and the reason is shown as a
  banner. The message is deliberately non-specific: the server does not tell an unauthenticated
  caller whether the address was unknown, the domain unverified or the membership missing.
- Nothing new stores a token. The session and the MFA challenge are both `HttpOnly` cookies this
  code cannot read.

**New styles** (`packages/ui/src/styles/components.css`): `.uboss-totp-secret`,
`.uboss-recovery-codes`, `.uboss-link-button` and the `.uboss-factor-row` family. All built from
existing tokens — no new visual language, and the login card keeps the reference's structure with
only its contents changing, exactly as `/activate` and `/access-help` already do.

### Prompt 7 — internal permission test page

One route, and it is a diagnostic rather than a feature.

| Route                   | Purpose                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `/internal/permissions` | Ask the authorization engine one question and see the whole layer-by-layer reasoning |

**Why it exists.** A five-dimension, five-layer engine is close to undebuggable from the outside.
"Why can this Manager not approve this?" should be answerable in one place, and the answer should
name the layer that decided rather than saying "forbidden".

**Behaviour worth knowing:**

- **Not linked from anywhere**, and deliberately absent from `COMPANY_NAV`. It is reached by typing
  the URL, by whoever is debugging.
- **Every dropdown is populated from the server**, via `GET .../authorization/vocabulary`, which
  serves `@uboss/types`. Hard-coding the module or action lists here would let the page drift from
  what the server enforces, which would make it worse than useless — a debugging tool that lies.
- It shows the **decision trace**, and the endpoint behind it is platform-only for exactly that
  reason: the trace describes a company's policy configuration, and a normal 403 never carries it.
- It can evaluate a **hypothetical resource** — one that does not exist — because "what would
  happen if" is the question being asked.
- There is a checkbox to ask the question **as an Engine Agent or the Executor Agent**, so the
  locked rule (an automated actor cannot satisfy a required human approval) is demonstrable rather
  than only asserted in a test.
- The TCSiON panel shows the server's own note when nothing has been loaded, so an empty table
  reads as "the approved reference has not been supplied" rather than as a bug.

**New styles**: `.uboss-checkbox` and `.uboss-mt-16`, both generic enough to belong in the design
system rather than in one page. No new visual language.

**No other UI was added.** The prompt permitted an internal permission test page and nothing else,
and the roles, users and settings screens that would consume this engine belong to the prompts that
own them.

---

### Prompt 8 — internal audit read page

One route, and again a diagnostic rather than a feature.

| Route             | Purpose                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `/internal/audit` | Read both trails, verify the chains, and see the exact tamper-evidence guarantee |

**Why the Security Center is not here.** Prompt 8 asked for tested services and APIs and
explicitly **not** the full Security Center UI. The real screen is the `audit` section of
Settings — "Audit & Activity" in the reference — and it belongs to a later prompt. Building a
convincing-looking Security Center now, over services whose retention, alerting and incident
workflow do not exist, would make the product look finished in the one area where looking
finished is most dangerous.

**Behaviour worth knowing:**

- **Not linked from anywhere**, absent from `COMPANY_NAV`, reached by typing the URL — the
  same standing as `/internal/permissions`.
- **The guarantee is printed verbatim, caveat included.** `POST .../audit/verify` returns the
  guarantee as prose whose wording _changes_ depending on whether a checkpoint has been anchored
  outside the database, and the page shows it as-is — including the half that begins "NOT
  guaranteed". A screen that rendered a green tick and dropped the caveat would be worse than
  showing nothing, because somebody would rely on it.
- **Unchained rows are labelled, not hidden.** A row written before Prompt 8 shows
  `unchained` in the position column, and the verification summary states how many rows the
  check does not cover.
- **The category dropdown renders from the server's vocabulary**, for the same reason as the
  permission page: a hard-coded list drifts, and a diagnostic that lies is worse than none.
- **Refusals are shown as the server wrote them.** "Reading the audit trail requires
  whole-company scope; this grant is Department" _is_ the diagnosis, so it is not replaced with a
  generic failure message.
- `Notice` severity renders grey, not amber, matching the server's classification table.
  Colouring every notice amber would train the reader to ignore amber.

### Prompt 9 — the UBoss Master Console

Sixteen routes, using the Prompt 2 `master` shell. The first real screens in the product outside
authentication and two internal diagnostics.

| Route                          | State | Notes                                                                        |
| ------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `/master`                      | —     | Redirects to `/master/dashboard`, as the reference's router does             |
| `/master/dashboard`            | built | Platform Overview: 4 KPIs, attention, security, renewals, alerts, provenance |
| `/master/companies`            | built | The reference's 7 columns, its toolbar, client-side filtering                |
| `/master/companies/[tenantId]` | built | Company Detail: KPIs, profile, entitlements, its own trail                   |
| `/master/create-company`       | entry | **No form and no submit** — the wizard is the next prompt                    |
| `/master/plans`                | built | Plans, entitlements, subscriber counts, retirement state                     |
| `/master/release`              | built | Feature flags; Owner-only to control, read-only for the rest                 |
| `/master/security`             | built | Access review, platform staff with no role, security events                  |
| `/master/platform-settings`    | built | Two data-driven sections; locked rules shown and refused                     |
| `/master/health`               | part  | Real service alerts; the four reference KPIs named and empty                 |
| `/master/billing`              | shell | No payment provider connected                                                |
| `/master/credits`              | shell | No AI metering exists                                                        |
| `/master/providers`            | shell | No provider adapters registered                                              |
| `/master/skills`               | shell | No skill model. **Not** the Templates Library, which is out of scope         |
| `/master/testing`              | shell | Nothing runs yet, so a pass rate would have no subject                       |
| `/master/support`              | shell | No ticket model; break-glass is the built support capability                 |
| `/master/dev-ops`              | shell | Not in the client's Prompt 9 list, present in the locked nav                 |

**Navigation is filtered by the server.** The sidebar renders `MASTER_NAV` intersected with the
`navigation` array from `GET /platform/console/me`, so the console cannot offer a module the API
would refuse. Still a rendering hint and not the enforcement — the standing property since UX_MAP
defect 7 — and every route carries its own server-side check.

**A platform actor holding no platform role sees an explanation**, not an empty sidebar and a wall
of 403s. `platformContext` fails closed as of this prompt, and a fail-closed design that cannot be
debugged from inside the product is a support burden rather than a security win.

#### Divergences from the reference, and why

Four, all deliberate and all in the same direction — refusing to render a control that would
either lie or work too easily:

1. **No "Skip to review & provision" on Create Company.** The prototype has a working shortcut
   that toasts and navigates. Carrying it forward would be a provisioning path that skips plan,
   entitlement, budget and security selection — exactly what this prompt was told not to build.
   There is no `POST` behind the screen at all (ADR-052).
2. **No "Impersonate (audited)" on Company Detail.** That is break-glass by another name, and
   break-glass exists properly (ADR-048) with identity verification, a second approver, a bounded
   scope, an expiry and a customer notification. A one-click button beside a company would route
   around all of it. The screen explains the real path instead.
3. **No "Suspend tenant" button.** A lifecycle transition needs a reason, a confirmation and a
   notification path. Listed as unbuilt rather than shipped as a control that would work.
4. **No fabricated KPI deltas or health figures.** The reference shows "+3 this month", "82%
   utilized", "99.98% uptime", "240ms p95", "98.6% run success". Seat utilisation is computable
   and is shown; the rest are not, and are named-and-empty rather than filled in. A health screen
   showing an uptime figure no probe measured is the most dangerous fake data in an operations
   console (ADR-051, S-056).

Each is recorded here rather than left as an apparent oversight — a reader comparing the console
to the prototype will notice all four.

#### A stylesheet defect found and fixed

`uboss-hint` was used nine times across the web app and **has no CSS rule** — it had been
rendering unstyled since Prompt 8, when this codebase first used it. Replaced with
`uboss-muted-3` everywhere, including the Prompt 8 audit page. The lesson recorded rather than the
fix alone: a class name invented at the call site looks correct in review and is invisible in a
typecheck.

### Prompt 10 — the Create Company wizard

`/master/create-company` stops being an entry screen and becomes the real ten-step wizard. The
step names and their order are the client's, from the approved wizard table.

| Step | Name                              | Notable                                                        |
| ---- | --------------------------------- | -------------------------------------------------------------- |
| 1    | Company Identity                  | Code upper-cases as typed; timezone framed as company data     |
| 2    | Initial Company Super Admin       | **No password field**, and a banner saying why                 |
| 3    | Commercial Plan                   | Choosing a plan pre-fills seats, currency and step 7's budget  |
| 4    | Modules / Entitlements            | Live effective-modules preview; "withheld wins" stated         |
| 5    | AI Mode                           | BYOK shows a 40-char **hint** field and a do-not-paste warning |
| 6    | Skill Packs                       | States it is not a Templates Library                           |
| 7    | AI Budget Policy                  | Four ordered guardrails, warn → approve → stop                 |
| 8    | Security Defaults                 | SSO-required warned against before a connection exists         |
| 9    | Review & Provision                | **Impact**, not a summary — see below                          |
| 10   | Send Secure Activation Invitation | The outcome, including the UBoss Unique ID                     |

**Step 9 shows impact rather than a summary.** A list of the values just typed would be a
summary. What it shows instead is what provisioning _will do_: which modules become available,
what the guardrails will refuse, that a bootstrap Company Admin will be granted with no human
grantor, that an invitation will be queued and no password created. Those are the consequences
worth reading before clicking, and the client asked for an "impact summary" specifically.

**One submit, and an unsaved-changes warning.** Nothing is saved until step 9 because provisioning
is one transaction (ADR-054), so navigating away loses the form and the wizard warns. Losing a
form is recoverable; a half-created tenant is not.

**Per-step validation disables Continue** rather than letting somebody reach step 9 with an
invalid step 1. The server validates everything again — this is a courtesy, not the enforcement.

**Step 10 is honest about the invitation being queued, not sent.** No dispatcher runs yet, so the
outcome screen says so and points at the outbox view. The alternative would be a screen implying
mail went out.

**A caller without `create-company:Create` sees an explanation**, not an empty form or a wall of
403s — including the note that this is the only path because there is no public signup.

### Prompt 11 — plan, seats and lifecycle, on both sides

| Route                                     | App | Purpose                                                                       |
| ----------------------------------------- | --- | ----------------------------------------------------------------------------- |
| `/master/companies/[tenantId]/commercial` | web | Platform side: contracted seats, operating state, the company's request queue |
| `/settings/billing`                       | web | Company side: plan, entitlements, allowance, seats, and requests              |

**The Prompt 9 placeholders are gone.** Company Detail listed "Suspend company" and "Change
commercial terms" under _Not built yet_, with the reason: a lifecycle change needs a reason, a
confirmation and an impact preview. Both are built now, and they arrived in exactly that shape —
on their own screen, because the page somebody opens to _read_ a number is the wrong place to
_change_ one. The detail page now links to it instead of listing it as unbuilt.

**Every dangerous control shows its impact and demands a reason.** `ConfirmDialog` with
`requireReason` on both the seat change and every lifecycle transition, and the impact lines name
the thing customers ask about first: **"People removed by this change: None — this change deletes
nothing"**. Closing is styled destructive and says it cannot be undone through that route.

**A seat reduction is previewed before it is offered.** The operator types a number and the screen
calls `seat-reduction/:seats` first, so the confirmation carries the API's own assessment — how
many seats are in use, how far over the new ceiling that is, and whether a grace window will open —
rather than a number the screen guessed.

**The seat count is explained, not just displayed, on both screens.** The counting rule in words,
then a per-state breakdown with each state badged **Counted** or **Free**. "31 seats used when 28
people work here" is a support ticket; a reconstructable number is not.

**The company side is read-and-request, and there is no control that sets anything.** Not a
disabled one, not a hidden one — no field exists (S-063). The request form asks what is needed and
_why_, with the justification mandatory, and the screen states that whoever raises a request can
never be the person who approves it.

**A scheduled change is never shown as though it had happened.** A future lifecycle transition
renders as an information banner saying the company is _still_ in its current state until the
date; a pending plan change says the company keeps what it has until then. Showing a customer as
suspended before they are would be a false statement about their access.

**Two panels say what is not built** rather than mocking it: invoices and payment methods (their
own prompt), and per-run AI usage detail (arrives with metering). The allowance figure is the
contracted amount and what has been recorded against it — the Prompt 9 provenance rule applies.

**Where the company-facing screen lives.** `/settings/billing`, following the `/sessions`
precedent from Prompt 6: `AppShell variant="company"` with the full `COMPANY_NAV` and breadcrumbs
`Settings → Billing`. The 19-category Settings shell with its own left navigation is Prompt 14,
and building half of it early would have to be undone.

---

### Prompt 12 — Organization Hierarchy, matched to the reference section by section

| Route             | App | Purpose                                                            |
| ----------------- | --- | ------------------------------------------------------------------ |
| `/hierarchy`      | web | Vision/Mission strip, Tree View (default) and List View, Add flows |
| `/hierarchy/[id]` | web | Employment identity and UBoss identity for one person              |

**What was matched, and to which piece of `index.html`:**

| Reference                           | Built as                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vmStrip()`                         | `<VisionMission>` — the same 1fr/1fr grid, navy gradients, uppercase labels and 120px corner glow, with the labels **Company Vision** / **Company Mission** verbatim                                                                                                                                                                                 |
| `.seg` Tree view / List view        | `<SegmentedControl>` — the reference's 3px padding, 9px radius and `.on` state. **Tree View is the default**, as specified                                                                                                                                                                                                                           |
| `.search-mini` "Search people"      | `<SearchField>` with the same placeholder                                                                                                                                                                                                                                                                                                            |
| `<select class="filter">`           | `<FilterSelect>`, "All departments" first                                                                                                                                                                                                                                                                                                            |
| Add Department                      | a modal; `hierarchy:Administer` only                                                                                                                                                                                                                                                                                                                 |
| Add Employee (primary button)       | the six mandatory fields, then "Optional details", then the result                                                                                                                                                                                                                                                                                   |
| `orgSVG()` / `nodeSVG()`            | `<OrgChart>` — the same box geometry (214×64, 22/50 gaps), elbow connectors, company/department/person node shapes, the five named department colours from `DEPT_COL`, and the `+` / pencil circle actions                                                                                                                                           |
| the list table                      | the reference's seven columns in order: Employee, Employee ID, Designation, Department, Reporting Manager, UBoss ID, Status                                                                                                                                                                                                                          |
| `empProgress()`                     | `<ProgressStep>` with three steps while saving                                                                                                                                                                                                                                                                                                       |
| `empResult()`                       | the centred dashed panel, `PERMANENT UBOSS UNIQUE ID`, 30px mono id, Copy ID, then the Employee ID and masked Aadhaar rows                                                                                                                                                                                                                           |
| Node action **Move/Change Manager** | a control on the profile — it needs a target and a reason, and the node's Edit action is what navigates there. The picker deliberately still lists the person's own subordinates: the server refuses the loop with an explanation, which teaches the rule, whereas omitting them silently would leave an administrator wondering where somebody went |
| `SCR.employee`                      | the 340px + 1fr two-column profile, the reference's key-value order, the blue mono UBoss ID with a copy action, `XXXX XXXX ####` masked Aadhaar, and the pill tabs                                                                                                                                                                                   |

**Three deliberate divergences, all recorded rather than silent:**

1. **Full screen and Download are not built.** Both are presentation features over the chart. The
   toolbar omits them instead of shipping buttons that do nothing.
2. **The profile's Performance, Achievements and Access tabs render, and say they are not built.**
   The reference shows a score of 82 and 96% on-time; those come from a feature area that does
   not exist. Putting invented numbers on a real person's profile is the worst kind of
   placeholder, so the tabs keep the approved layout and a _Not built yet_ panel names what is
   missing and which prompt owns it.
3. **A department colour is derived for departments the reference does not name.** The five named
   ones keep their exact colours from `DEPT_COL`; anything else is hashed into a fixed palette so
   the same department is always the same colour. A missing colour would be worse than a derived
   one, and a colour that moved between loads would make the grouping useless.

**Two rules the screen states rather than merely obeys:**

- **No Invite button.** Not on a node, not in the toolbar, and the API has no such route. A
  notice under the card says adding somebody records them and **does not invite them**, and names
  Settings → Users & Access as the place that does. The Add Employee form and the result panel
  both repeat it.
- **The masked identifier is withheld from colleagues.** An ordinary employee gets no Aadhaar
  column and no Aadhaar row — the field is _absent_, not blank, so it cannot read as "nothing on
  record". The reference shows the row unconditionally because a prototype has one viewer.

**Empty states are designed.** A company with departments and nobody recorded shows "No employees
recorded yet" with the next action, not a blank chart. A company with no Vision yet shows a muted
prompt in the strip rather than an empty gradient panel that reads as a failed load.

**New shared primitives:** `VisionMission`, `SegmentedControl`, `OrgChart` — added to
`@uboss/ui` rather than built in the page, because the reference uses the strip and the segmented
control on other screens too, and a chart in a page file cannot be reused by the export flow a
later prompt will want.

---

### Prompt 13 — Users & Access, matched to the reference

| Route             | App | Purpose                                                                    |
| ----------------- | --- | -------------------------------------------------------------------------- |
| `/settings/users` | web | Employees, Guests and Pending Invitations; invite, suspend, offboard, bulk |

| Reference                           | Built as                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `.seg` Employees / Guests / Pending | `<SegmentedControl>` with the server's own three splits and live counts                                               |
| `.search-mini` "Search"             | `<SearchField>` over name, email, Employee ID and UBoss Unique ID                                                     |
| **Bulk import**                     | a validate-then-apply modal with a per-row error table                                                                |
| **Invite existing employee**        | a per-row Invite/Resend action, keyed on the person                                                                   |
| the table columns                   | Identity, Role, Manager, Activation, Invitation, actions                                                              |
| the closing notice                  | verbatim in substance: lifecycle is managed here, separately from the hierarchy, and permissions are backend-enforced |

**Three deliberate divergences:**

1. **"Last access" is not shown.** The prototype renders "Today 08:42" for everybody. Session
   last-seen exists _per session_, so one figure per person would mean choosing which session
   counts — and the prototype's value is invented. The column shows the invitation date instead,
   which is something the system actually knows.
2. **The Role column shows a count, not a title.** A person can hold several assignments with
   different scopes; the reference's single "Company Admin" / "Member" badge cannot represent
   that, and picking one would misreport the others. `No role` is badged as a **warning**, because
   it is the reason an invitation cannot be sent.
3. **"Invite guest" is a first-class toolbar action.** The reference has only "Invite existing
   employee"; guests are a client requirement with their own rules (outside the hierarchy,
   resource-scoped, expiry-capped), and burying them in a tab with no way to create one would
   make the tab permanently empty.

**What each row explains rather than merely refuses.** When somebody is not ready to activate,
the Activation cell names what is missing — "Needs a department, at least one company role" — and
the Invite button is disabled. The administrator's next question is always _why_, and a disabled
button with no reason is the difference between a screen that helps and one that stonewalls.

**Every dangerous action shows its impact.** Suspension uses `ConfirmDialog` with a typed reason
and impact lines that say **"Roles removed: None — they are kept"** and **"Reversible: Yes"**.
Offboarding fetches the real impact from the API first — direct reports, roles to revoke, and the
domains that cannot be transferred yet — and requires a successor when there are reports.

**The bulk flow shows every row before anything happens.** Validate produces a table of row
number, outcome and _all_ problems per row; the apply button is labelled with the count it will
act on ("Apply 397 valid row(s)"); and the note states that each row is applied as you, with your
permissions and against the seat ceiling. Cancelling keeps the row outcomes.

---

### Prompt 14 — Company Settings, the full information architecture

| Route       | App | Purpose                                                                  |
| ----------- | --- | ------------------------------------------------------------------------ |
| `/settings` | web | Left navigation, right detail panel, 19 categories, four of them working |

| Reference                        | Built as                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Settings: left nav + right panel | `SettingsShell`, the Prompt 2 primitive — a locked UI rule                                                      |
| 19 role-scoped categories        | `SETTINGS_SECTIONS`, filtered by what the **server** returned                                                   |
| personal label variants          | My Profile / Login & Security / My Connections / My Agent Preferences, used when the caller administers nothing |
| General                          | workspace display name, business timezone, week start                                                           |
| Organization                     | default hierarchy view, Employee ID uniqueness, and a link to the Hierarchy screen                              |
| Notifications & Escalations      | approval reminder, escalation window, exception notification, digest                                            |
| Appearance                       | accent colour, table density, reduce motion                                                                     |

**Every value shows where it came from.** A badge reads _Set by this company_, _Platform default_
or _Default_, and where a company value differs from the default the panel says what the default
is. A settings screen that shows only a number invites somebody to believe the company chose it.

**A governance setting is marked and behaves differently.** A purple _Governance_ badge, a
mandatory reason field that appears only when a material setting is dirty, and a **Change
history** button showing every previous value with its reason.

**The unsaved-change warning has two halves**, because one cannot cover the other: switching
category in-app asks for confirmation, and closing the page uses `beforeunload`. A browser dialog
cannot be raised for an in-app navigation, and losing a half-typed governance change with no
warning is the kind of small betrayal that makes people distrust a tool.

**Fifteen categories have no controls, and each says why.** That is the prompt's own instruction —
"do not implement each deep module yet" — so a category shows either where its configuration
actually lives ("Managed on Settings → Users & Access", with a button that opens it) or which
prompt brings it. An empty panel would read as a broken screen; a missing sidebar entry would
read as a permission problem. Both are worse than a sentence.

**Withheld categories are counted, not hidden.** A caller who cannot read a category does not see
it in the sidebar — and a banner says how many were withheld and why, so a shorter list is a
permission boundary rather than a missing feature.

**One divergence from the pack, resolved by precedence.** The original Prompt 14 lists **17**
categories; the client's later amendments added UBoss Profile Search Policy and Performance &
Reward Policy, and `SETTINGS_SECTIONS` has had **19** since Prompt 2. The precedence rule puts a
later client correction above the pack, so nineteen ship — and the two extra ones carry notes
naming the prompts that will fill them.

---

### Prompt 12B — Performance and badge history

| Route                 | App | Purpose                                                                          |
| --------------------- | --- | -------------------------------------------------------------------------------- |
| `/performance`        | web | One person's score movement and badge progression (`?userId=` for somebody else) |
| `/performance/badges` | web | Every level held, as a transition table                                          |

| Reference                                  | Built as                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SCR.performance`, two columns `1fr 340px` | The same split: progression and timeline left, the score panel right                                                                      |
| Badge progression strip                    | `BadgeProgression`, a new primitive over `MedalBadge` — five medals, each over a bar filled to the level held                             |
| Event timeline (governed events)           | `uboss-kv` rows with signed points, the outcome in words, and the source that produced it                                                 |
| Current score panel                        | The score as one large figure with its medal, then On-time delivery, Positive events, Approved exceptions, Next threshold                 |
| `badgeHistory()`                           | The same six columns — From, To, Date, Score, Reason, Policy version — with the same closing notice                                       |
| Employee profile pill tabs                 | Performance and Achievements now **navigate** to these two screens, which is where the reference puts them (`data-nav="app/performance"`) |
| Employee profile mini cards                | Current performance and On-time delivery, with real numbers                                                                               |

**Every number is real or absent.** The prototype shows a score of 84 and "Platinum @ 88" from a
fixture. These screens show the score the server derived and the thresholds the company actually
configured — and **nothing** where there is nothing. An on-time percentage is omitted rather than
rendered as 0% for somebody who has not completed anything, because zero is a different claim.

**The reference's "last 90 days" label is not repeated.** The engine scores the whole employment,
so the profile card says "across all recorded work". Keeping the prototype's label would have been
a false claim about what the figure covers.

**A forgiven outcome is struck through, not removed.** An event an approved blocker neutralised
still appears in the timeline with its points struck and the reason shown. It happened; what
changed is what it costs.

**A refusal reads as a refusal.** The employee profile fetches performance separately and
tolerantly: seeing somebody in the hierarchy and reading their score are different permissions, so
a 403 leaves the two mini cards saying _"Not shown — you do not have access to this person's
performance record"_ rather than emptying the whole screen. A permission boundary that looks like
missing data is the thing that generates support tickets.

**One deliberate divergence.** `useSearchParams` needs a Suspense boundary, so each page's default
export **is** the boundary and the screen is its child — without one the production build fails
outright rather than degrading.

---

### Prompt 15 — Notification Center, the bell, and preferences

| Route                                     | App | Purpose                                                                 |
| ----------------------------------------- | --- | ----------------------------------------------------------------------- |
| `/notifications`                          | web | The centre: four tabs, full history, acknowledgement                    |
| `/settings` → Notifications & Escalations | web | Personal preferences per kind, beside the company's alert configuration |

| Reference                                               | Built as                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Top-bar bell with a dot                                 | `TopBar` gains an unread **count badge**, urgent while something awaits acknowledgement |
| `notifications` settings card (Digest, Acknowledgement) | `NotificationPreferences`, in that category — where the reference puts them             |
| _(no counterpart)_                                      | The centre page itself                                                                  |

**The reference has no notification screen.** Its bell navigates to the To-do list — one of the
prototype's orphaned-screen defects — and the pack requires a centre page and a drawer. So this
screen is built from the pack's feature list using the approved design system (`AppShell`, `Tabs`,
`Card`, `StatusBadge`, the existing severity tones) rather than inventing a look. That divergence
is recorded here because it is the first screen with no prototype counterpart.

**The count is a badge, never part of the label.** A locked rule, and the accessible name carries
the real number ("Notifications: 4 unread, 1 needing acknowledgement") because a visual badge
reaches nobody using a screen reader. Capped at `99+` so a four-digit number cannot break the bar.

**Nothing unread but something awaiting acknowledgement shows a dot, not a `0`.** A zero badge
would say the opposite of what is true, and this is precisely the state a critical alert leaves
behind — reading it does not clear it.

**Four tabs, because there are four questions.** What is new; what have I not read; what is
waiting on **me**; what must I acknowledge. The last two are genuinely different, which is also
why the bell carries two numbers.

**History is the default view.** "All" includes what has been read and acknowledged, because the
client requires history — a centre that emptied as you read it would answer "what happened last
Tuesday" with silence.

**The whole row is the deep link**, and opening it marks it read. A notification's link is its
point: "something needs you" with no route to it is worse than silence. Unread carries a left rule
rather than a background wash, so a busy list stays readable and the marker survives greyscale.

**A critical row keeps its Acknowledge button** with the sentence "Reading this does not clear it
— somebody has to say they have seen it."

**A forgiven or escalated item stays visible.** The original of an escalation is still in the
recipient's list, badged _Escalated_; the manager's copy is badged _Escalated to you_. Escalating
tells somebody else; it does not take the item away.

**An immutable preference is disabled and says why**, and the screen asks the _same_ function the
engine asks — a checkbox offering to mute something the engine will send anyway would be a lie
told by the UI. Each kind also states whether anything raises it yet, because three of the six
arrive with later prompts and implying they are live would be the dishonest choice.

**One shared `NotificationList`** for the centre and the bell's drawer, because two
implementations would drift — and the half that would go missing is the acknowledgement control,
which is the whole reason a critical alert exists.

**One shared `useNotificationBell` hook** across every authenticated company screen. No polling
and no socket: the counts are read per screen and on request. A poll every few seconds across
every open tab is real load for a number that is usually zero, and live push is its own piece of
work. The consequence is small and stated — a notification raised while somebody sits on one
screen appears on their next navigation.

---

### Prompt 16 — Integrations & Connections

| Route                                    | App | Purpose                                                   |
| ---------------------------------------- | --- | --------------------------------------------------------- |
| `/settings` → Integrations & Connections | web | The connection list, the add drawer and the manage drawer |

| Reference                                                                 | Built as                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `setIntegrations()` card with **Add connection**                          | `ConnectionsPanel`, in that Settings category                                     |
| Table: Connection / Owner / Environment / Health / Affected agents / Test | The same six columns, same order                                                  |
| Prototype's three health values                                           | The client's **five** real states — that is the pack's list, not an embellishment |

**The credential is never on this screen.** No field shows one, no response carries one, and the
Add and Rotate forms are the only places one is typed — as a password input. The manage drawer
shows the `secret_ref` handle, because that is what a connection actually stores.

**A high-risk grant is visible at a glance, with its reason.** This is the screen where somebody
has to be able to see that an agent can delete from the company's ERP, so the red _High risk_
badge and the reason are on the row rather than behind a detail view. The reason field appears
**only** when the chosen category is high-risk, and the Grant button stays disabled until it is
filled — the same shape as the Prompt 14 governance-reason field.

**The category chooser offers only what the connector supports.** Granting a category the
connector cannot perform would be a permission that reads as capability and is not.

**The vault says what it is.** A _No external provider_ badge and the vault's own sentence, because
"encrypted at rest in our own database" is a real guarantee and a different one from "held in a
managed secrets service".

**A mock connector says so, and says how to drive it.** The add drawer lists the four instructions
(`mock:ok`, `mock:reauthorize`, `mock:expires:<date>`, `mock:fail:<message>`) so every state the
screen can display is reachable before a real vendor exists. Better than a screen whose failure
states nobody can see.

**Disabling explains the surprising half.** The confirmation says grants are kept, so enabling
restores the configuration rather than requiring it to be rebuilt — and the reason field is
mandatory, because every Engine Agent using the connection stops working and whoever finds that
out needs to know why.

**Company-level actions appear only when the server says so**, and the server refuses them
regardless. An employee reaches the same panel and sees their own personal connections with the
controls that are theirs.

---

### Prompt 17 — Skills & AI

| Route                     | App | Purpose                                                           |
| ------------------------- | --- | ----------------------------------------------------------------- |
| `/settings` → Skills & AI | web | The library, the governance queue, and each Skill's detail drawer |

| Reference                                                            | Built as                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `skills` panel sub-navigation (Library / Governance / Custom skills) | `SegmentedControl` with those three views                               |
| Table: Skill / Version / Lifecycle / Impact                          | Skill (with layer badge) / Version / Lifecycle / **Autonomy** / actions |
| Action row: Add skill / Create with UBoss AI / From SOP / Clone      | **Clone is live**; the other three state what they need                 |
| `Corrections` column                                                 | **Not built** — see below                                               |

**The reference's `Corrections` column is deliberately absent.** Corrections are evaluation data,
which is the next prompt's ("saved evaluation cases"). A column of zeroes would read as "nothing
has ever been corrected", which is a claim rather than a gap.

**`Autonomy` replaces it**, and earns the space: it is the field that decides whether a capability
can act unattended, and a row whose Skill declares a high-risk tool category carries a red
_High-risk tools_ badge next to it. That pairing is the one thing a reviewer scanning this table
most needs to see.

**A platform Skill says it is not editable, and says what to do instead.** The drawer carries the
layer's description and, for a Verified Skill or Industry Pack, a banner: _"It can be used or
cloned here, never edited — a clone has its own approval trail, which is what makes it different
from copying a template."_ The locked rule made visible rather than merely obeyed.

**"When not to use it" gets its own row.** It is the field people skip when authoring and the one
that stops a Skill being used for the wrong work, so the detail drawer gives it equal weight with
"when to use it" rather than folding both into a paragraph.

**The lifecycle buttons come from the server.** Each version response carries `nextStatuses`
straight from the transition table, and the drawer renders exactly those — so the screen can never
offer a move the service will refuse, and a change to the table changes the buttons without a
second edit. A reason field appears only for the moves that require one (send back, deprecate,
archive) and the button stays disabled until it is filled.

**The impact panel says what it cannot see.** Three of the five domains show an _Unknown_ badge
with the prompt that will make them real, under a banner explaining that unknown is reported
rather than zero _"because a zero would read as nothing is affected"_. This is the one screen in
the product where an under-report could cause somebody to break live work.

**The clone drawer explains what a clone is.** Not "copy this" — a banner states that the result
is a Company Custom Skill with its own draft, its own approval and a recorded link back to the
source, and that **it starts as a draft**: nothing is live until somebody in this company approves
and publishes it.

**Three creation modes are described rather than offered.** Manual and From-SOP are accepted by
the API today, but their authoring form is a long governance document (fifteen fields) that
belongs with the Agent Builder screen which consumes it; Create-with-UBoss-AI needs the Model
Gateway. Each is listed with what it waits on, because a button that opens a form the server will
refuse is worse than one that explains.

---

### Prompt 18 — Skill Router and evaluation: no screen, and why

**This prompt ships no UI, deliberately.** The pack asks for the router, saved evaluation cases and
a regression comparison data model — data and API — and the approved reference has no router
screen to match. Three reasons for not inventing one:

1. **The router has no user-facing moment yet.** Nothing calls it: Engine Agents and the Objective
   analyzer arrive at later prompts, and the pack says explicitly "no Objective analyzer yet". A
   screen that let somebody route a task by hand would be a debugging tool dressed as a feature.
2. **The comparison view belongs next to publication.** A regression comparison is read at the
   moment somebody publishes a version — which is the Skills panel's version detail, and that
   panel's shape is settled by the prompt that builds a real authoring form. Putting a comparison
   table somewhere else now would mean moving it later.
3. **The Candidate queue is a governance inbox**, and the client's approved Settings information
   architecture has no entry for one. It fits either under Skills & AI or in the Approvals module,
   and the Approvals module arrives at Prompt 24 with the generic Approval Engine the client
   specified. Choosing now would be guessing which.

What Prompt 17's panel already shows and what this prompt adds behind it:

| Visible today                                  | Behind it                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Each Skill's lifecycle status and version      | Which versions the router will consider (`Published` only)                                             |
| The Governance tab (Skills with an open draft) | Where a comparison view will sit, beside the version being published                                   |
| _(nothing)_                                    | The Candidate queue, served by `GET /skill-router/candidates` and ready for whichever screen claims it |

**The API is complete and explains itself in the meantime.** `GET /skill-router/meta` publishes the
router's own parameters — the result cap, the confidence floor, the assertion kinds, the verdicts
and the candidate statuses — with a note stating the two rules it enforces. Every routing response
carries reasons and every rejection its rule, so the first screen to consume this has everything it
needs to be explicable rather than a black box with a number in it.

---

## 1a. UI reference override audit

The reference defines seven things **twice**, and the later definition always wins. This table
records which one is effective, because reading the file top-to-bottom gives the wrong answer.

| Definition      | Superseded (first)                            | **Effective** (second)                                                                                         | Status                                        |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `SCR.login`     | Plain list, "One platform, six disciplines"   | **Radial mind-map**: rings, six SVG connectors, `UB` centre, 3 cards per side, assurance strip, dev quick-fill | Corrected at Prompt 5                         |
| `sidebar()`     | Name + role in the footer, no collapse toggle | **Collapse toggle, `brandtext`, `nav-lbl`, role-filtered items, badge only when > 0, Sign out in the footer**  | Matched (Sign out added at Prompt 5)          |
| `topbar()`      | Workspace switcher arrow, no scope pill       | **Scope pill (`role · scope`), a sign-out icon button, avatar, no switcher arrow**                             | Matched (sign-out + avatar added at Prompt 5) |
| `SCR.settings`  | Category-name-derived keys, four real panels  | **Keyed pages, role-scoped list, personal labels for non-admins**                                              | Matched at Prompt 2                           |
| `SCR.stub`      | "Screen coming in next pass"                  | **"This route isn't part of your current scope" + Go to Dashboard**                                            | Not yet transcribed                           |
| `objForm()`     | —                                             | (second definition)                                                                                            | Due at Prompts 15–19                          |
| `objWorkflow()` | —                                             | (second definition)                                                                                            | Due at Prompts 15–19                          |

The effective login's exact copy, for the record:

| Section     | Side  | One-liner                  |
| ----------- | ----- | -------------------------- |
| MAP         | left  | Departments and people     |
| Optimize    | left  | Objectives and their plans |
| Build       | left  | Agents built and released  |
| Operate     | right | Approved versions, running |
| Govern      | right | Approvals and audit trail  |
| Manage Task | right | What is waiting on you     |

Assurance strip: **Tenant-isolated · Human governed · Fully audited**.

One element of the effective login is deliberately **not** rendered: the reference's stylesheet
keeps `.glow1` / `.glow2`, but its effective login stops emitting those elements. The rules are
retained in `components.css` so the stylesheet stays a faithful transcription, and
`LoginPresentation` emits no glow elements — matching what the reference actually draws.

---

## 2. Design tokens (from `index.html` `:root`) — now implemented in `packages/ui/src/styles/tokens.css`

| Group    | Values                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| Navy     | `#102A43`, navy-700 `#1C4A73`, navy-900 `#0A1E33`                                                                |
| Blue     | `#2563EB`, blue-600 `#1D4FD8`, blue-050 `#EEF3FF`, blue-100 `#DBE7FF`                                            |
| Cyan     | `#0BA6E4`, cyan-050 `#E6F6FD`                                                                                    |
| Semantic | success `#15803D`/`#E7F6EC`, warning `#B4610A`/`#FBF1E3`, danger `#BE1B1B`/`#FCEBEB`, purple `#6D28D9`/`#F1EBFC` |
| Surfaces | surface `#FFFFFF`, bg `#F5F8FC`, bg-2 `#EDF2F8`, border `#E4EAF2`, border-2 `#EEF2F8`                            |
| Text     | `#0F1D2E`, text-2 `#54637A`, text-3 `#8994A6`                                                                    |
| Geometry | radii 8/12/16, spacing unit 8px, shadows sh-1…sh-3, sidebar 248px, topbar 64px                                   |
| Type     | Inter 400–800, base 14px / line-height 1.45                                                                      |

CSS component blocks to become `packages/ui` primitives: App shell, Buttons, Cards, Badges, Tables,
Fields, Donut, Stepper, Workflow, Overlays, States — plus the polish layers (radial mind-map login,
top-down org chart, donut hero, SVG org chart).

---

## 3. Company Workspace screens — route `#/app/<key>/<sub>` in the prototype

| Key              | Sub-screens                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `dashboard`      | one donut, two slices only                                                                  |
| `hierarchy`      | tree, list                                                                                  |
| `employee`       | `:id`                                                                                       |
| `users`          | Users & Access                                                                              |
| `objective`      | list, form (Form 2), review, analyze, workflow, prepublish, versions                        |
| `agent-builder`  | work, setup, form3, test, pass, fail, missing, budget, approval, activate, activated, empty |
| `todo`           | list, detail                                                                                |
| `agents`         | list, detail, runs                                                                          |
| `executor`       | list, detail                                                                                |
| `approvals`      | list, detail                                                                                |
| `performance`    | list, badges                                                                                |
| `profile-search` | form, result                                                                                |
| `reports`        | list, `:id`                                                                                 |
| `roles`          | list, `:id`                                                                                 |
| `settings`       | 19 categories (§5)                                                                          |
| `states`         | shared UI-state reference                                                                   |

Sidebar groups: Home, Builders (Hierarchy, Objective Optimization, Agent Builder), Operations
(To-do List, Engine Agents, Executor Agent, Approvals, Reports), Settings.

---

## 4. Master Console screens — route `#/master/<key>/<sub>`

`dashboard`, `companies`, `create-company`, `company-detail`, `plans`, `billing`, `credits`,
`providers`, `skills`, `testing`, `release`, `support`, `security`, `health`, `platform-settings`,
`dev-ops`, `states`.

Sidebar groups: Platform, Commercial, AI Platform, Operate.

`dev-ops` has 22 subsections: overview, environments, builds, flags, services, queues, scheduler,
webhooks, gateway, storage, migrations, logs, errors, testing, sandbox, delivery, ratelimits,
maintenance, secrets, devtools, audit, version.

---

## 5. Settings — left navigation + right detail panel, 19 role-scoped categories

`general`, `organization`, `users`, `roles`, `objective`, `agent`, `skills`, `providers`, `tokens`,
`schedules`, `integrations`, `knowledge`, `notifications`, `security`, `audit`, `billing`,
`appearance`, `uboss` (profile-search policy), `performance`.

Company Admin and HR see all 19; Head sees all but `billing`; Manager, Employee, Approver, Auditor
and Guest each get a defined subset. For non-admins the labels re-personalize: General → **My
Profile**, Security → **Login & Security**, Integrations → **My Connections**, Agent → **My Agent
Preferences**.

---

## 6. Role model in the prototype (14 roles) — UI contract only

**Platform** (`kind: platform`): Platform Owner\*, Platform Admin\*, Finance, Support, DevOps,
Security.
**Company** (`kind: company`): Company Admin\*, Head — Regulatory, Manager, Employee, HR / People
Admin, Approver, Auditor, Guest. (\* = full navigation.)

Each role carries a label, kind, scope description and a navigation allow-list. A `ROUTE_GUARD`
blocks direct URL access — not merely hidden navigation — and renders a real permission-denied screen
with a route back; the topbar shows a `{role} · {scope}` pill.

This is the UI contract for the **TCSiON mapping seam**: _TCSiON User Type → UBoss Role → Scope →
Module Visibility → Allowed Actions_. It is **presentation only**; enforcement is server-side
(see SECURITY_DECISIONS S-008).

---

## 7. Prototype defects — status of each

1. **FIXED at Prompt 2 — dead navigation mutation.** The prototype splices items into groups named
   `Work & Agents` and `Admin`, but its actual groups are `Home / Builders / Operations / Settings`,
   so the **Roles & Permissions sidebar item and the Approvals badge were never inserted**.
   `COMPANY_NAV` now includes `roles` under an `Administration` group, and the Approvals badge is
   part of the model. A unit test asserts the `roles` key is present.
2. **FIXED at Prompt 2 — `users` screen orphaned.** Users & Access had no link anywhere. It is now a
   first-class `COMPANY_NAV` item, asserted by a unit test.
3. **OPEN — `objective/review` and `objective/versions` orphaned.** Both are implemented in the
   prototype but unlinked. Versions must be reachable, since it demonstrates the locked versioning
   rule. Due with the Objective module (Prompts 15–19).
4. **FIXED at Prompt 5 — duplicate definitions, and one was transcribed from the wrong one.**
   `SCR.login`, `SCR.settings`, `SCR.stub`, `sidebar()`, `topbar()`, `objForm()` and
   `objWorkflow()` are each defined twice, and the later definition wins. This entry previously
   claimed only the effective definitions had been transcribed. That was **wrong for the login**:
   `LoginPresentation` had been built from the superseded plain-list definition and its copy
   ("Chart your organization, roles and objectives" and four others), not from the effective radial
   mind-map. Rewritten at Prompt 5 to reproduce the override exactly — rings, six connectors, the
   `UB` centre, three cards per side, the real one-liners and the assurance strip — and the
   corresponding unit test was corrected rather than left asserting the superseded strings. The
   audit that produced §1a also found two smaller misses in the shells (the top bar's sign-out
   button and avatar, the sidebar footer's Sign out), both now added. See §1a for the full table;
   the React components each have a single definition.
5. **FIXED at Prompt 2 — credit lifecycle incomplete.** The prototype surfaced only _Estimate_ and
   _Settle_. `CreditMeter` renders all four stages (Estimate → Reserve → Execute →
   Settle/Reconcile), and a unit test asserts every stage is visible.
6. **FIXED at Prompt 5 — demo password literal.** The reference prefills its login password field
   with a shared demo password (`UBossDemo@2026!`) and offers a dev quick-fill panel listing every
   demo account. Neither is carried forward: no password field on `/login`, `/activate` or
   `/access-help` has a default value, and there is no quick-fill panel. See SECURITY_DECISIONS
   S-007 and S-021.
7. **FIXED at Prompt 7 — client-side-only authorization.** The reference hides navigation and
   enforces nothing. UBoss now enforces server-side at every layer: tenancy (Prompt 4),
   authentication and account state (Prompt 5), how a person is allowed to authenticate (Prompt 6),
   and **what they may do** (Prompt 7) — user type, role, scope, module visibility and allowed
   actions, composed through five policy layers, with two guards and Row-Level Security underneath.
   Navigation filtering remains presentation only, and that is now a stated property rather than a
   gap: `COMPANY_NAV` is a rendering hint, and every route carries its own `@RequirePermission`.
   The internal permission test page exists to prove the two agree. See SECURITY_DECISIONS S-008,
   S-040 and S-044.

   **Prompt 8 note.** Until Prompt 8 this was demonstrated on a probe controller declared inside
   a test suite. `/tenants/:id/audit/*` is the first **shipped** tenant-facing route group to
   carry `@TenantScoped` plus `@RequirePermission`, so the claim now rests on production code
   rather than on a test fixture.

---

## 8. Locked UI rules that every screen must satisfy

- Deep navy navigation, teal/blue-green accent, white/light cool-gray surfaces, comfortable
  enterprise density. Reusable components, not per-page styling.
- Desktop-first but responsive; keyboard accessible; **status is never colour-only**.
- Header on every authenticated company screen: **`UBOSS AI AMS | {Active Workspace Name}`**.
- Company Settings: left settings navigation, right detail panel.
- Objective Builder stays on the **left**; UBoss analysis/workflow opens on the **right**. Human
  nodes are rectangles/squares, **AI nodes are diamonds**, and the goal is visually distinct.
- Company Workspace Dashboard: exactly one donut, two slices (Agents, Pending Jobs), nothing else.
- **No dead-end screens** (CR-01/3): every screen offers a next action, Back, breadcrumb context, a
  route to the Dashboard, and detail → parent/list return — all permission controlled.
- No lorem ipsum. Realistic UBoss labels and demo data (the prototype's demo tenant is SPM Medicare).

### Prompt 19 — Objective Builder: `/objective` and `/objective/form`

| Route             | `index.html` counterpart | Effective definition                                     |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| `/objective`      | `objList()`              | Single definition.                                       |
| `/objective/form` | `objForm()`              | **Defined twice — the second (line 1792) is effective.** |

`objForm()` is one of the seven duplicate-defined functions. The effective version is materially
different from the first: it splits the form into **two cards**, adds the `Time Unit` select
alongside `Unit`, adds the two "no source field is dropped" notices, and captions the second card
"UBoss routing controls (separate from source Form 2)". Reading the file top-to-bottom gives the
wrong answer. Both were checked before building.

**What was matched, element for element:**

- Card 1, captioned `Form 2 — Objective definition (source fields)`, with the reference's field
  order and pairing: Objective Name / Department, Objective Owner / Prepared By, Expected Final
  Result (full width), Current Workload / Unit, Target Completion Time / Time Unit, Date at 50%
  width, then the `notice-min` about Unit and Time Unit never being collapsed.
- Card 2, tinted, captioned `UBoss routing controls (separate from source Form 2)`, holding
  Responsible Owner / Send To and Execution Team. The tint is a class, not an inline style,
  because the visual separation _is_ the point.
- The grid toolbar — `Workflow steps (source grid — 15 columns)` on the left, `Add Row` on the
  right — then the grid, then the `notice-min` about sticky headers and the unfixed row count.
- Page header: title `Objective — Form 2`, description "The original Form 2, field-for-field,
  before AI decomposition.", breadcrumb `Objective Optimization · <status>`.
- Actions in the reference's order: Performance & Reward, Save Draft, Submit for Review, Analyze &
  Generate Workflow.
- The grid itself: grouped sticky header (WHO / WHEN / WHAT / INPUT / WHERE / OUTPUT), sticky sub
  header beneath it, sticky Step column, horizontal scroll, and per-row ↑ ↓ + ⧉ ✕.

**The canonical field order differs from the render order, deliberately.**
`FORM2_OBJECTIVE_FIELDS` keeps the _source document's_ order, in which `Prepared By` follows
`Target Completion Time`. The reference lifts `Prepared By` up beside `Objective Owner` so the two
person fields pair. Both are honoured: the array is the canonical list, the screen is the canonical
layout. No field is dropped, renamed or merged either way.

**Four recorded divergences from the prototype:**

1. **No prefilled worked example.** The prototype hard-codes a GSPR checklist for IV Cannula in
   every input. A real screen starts empty — carrying the fixture forward would show every new
   objective as a GSPR checklist. (Working-method step 5.)
2. **The reward drawer has seven fields, not three.** The prototype's `reward-panel` overlay
   offers a policy link, a reviewer and free-text notes. The client's LATEST REWARD REQUIREMENT
   names Reward/Bonus Applicable, Reward Type, Amount/Points, Eligibility Condition, Completion
   Deadline, Evidence and Approver. The latest client amendment outranks the earlier prototype, so
   the seven fields are built — inside the prototype's drawer shell and keeping its banner wording
   about the panel being separate from Form 2.
3. **Analyze & Generate Workflow is present but disabled.** The reference navigates to
   `app/objective/analyze`, which is Prompt 21. Prompt 19 says "Do not build right-side AI workflow
   yet", so the button keeps its place and its label and says why it is unavailable. A button that
   silently did nothing would be worse.
4. **Department, Owner, Send To and Approver are id inputs, not pickers.** The people and
   department lists belong to the Hierarchy module; a second source for them here is how two lists
   come to disagree. The pickers arrive with the hierarchy-aware routing at Prompt 20.

**`objList()` columns, in the reference's order:** Objective (name over its code), Department,
Responsible manager, Status, Version, Target, Updated. The Version cell is a **badge** carrying
`V2 Live` — the locked rule about counts being badges rather than concatenated labels applies —
and it is green only when the version is genuinely live. Where the prototype's fixture always shows
a live version, a company with nothing published sees its draft's number in a grey badge instead.
`Responsible manager` says "Not yet sent to anyone" rather than rendering an empty cell.

**`objReview()`, `objAnalyze()`, `objPrepublish()` and `objVersions()` are not built yet.** They
are Prompts 20, 21 and 22. `objective/review` and `objective/versions` are two of the prototype's
seven known defects (orphaned, with no link to them); when they are built they get real navigation.

### Prompt 19A — Reward rules and awards: no new screen, and why

The prompt's scope is the `reward_rule`/`reward_award` lifecycle, the payroll connector boundary,
the performance-policy link, audit and tests — it ends "Add audit and tests. STOP." and names no
screen. The approved reference has no award screen either: its only reward UI is the
`reward-panel` drawer, which Prompt 19 already built with the client's seven fields.

So Prompt 19A ships the API and no new route, deliberately, and this is the record of that choice
rather than an omission. Two things a later UI prompt will need, both already served:

- **`GET …/rewards/meta`** carries every status with its permitted transitions and its tone, plus
  `payoutConnector.canSettle`. A Settle button must be driven by that flag: with no connector
  configured the product refuses, and a screen that offered the button anyway would be promising
  something it cannot do.
- **`payoutWasReal`** is on every award view. Any screen showing a settled award must show that a
  mock settlement was not a real payment. Rendering "Settled" alone would be the fixture-as-truth
  mistake the working method's step 5 warns about — the most consequential instance of it in the
  product, because the fixture in question is money.

### Prompt 20 — Objective versions & compare: `/objective/versions`

| Route                 | `index.html` counterpart | Effective definition            |
| --------------------- | ------------------------ | ------------------------------- |
| `/objective/versions` | `objVersions()`          | Single definition, at line 940. |

**Fixing prototype defect 3 of 7.** `objective/versions` is one of the two orphaned screens — the
prototype defines it and links to it from nowhere. It is now reachable from the objective form's
action row ("Versions"), next to Performance & Reward.

**What was matched:** the 280px timeline / 1fr detail grid; the "Version timeline" card built from
the `stepper` component with `V2 · Draft` labels and a sub-line under each; the warn banner in the
reference's own words ("Editing a Live objective never changes it in place…"); a "what changed"
section; and Compare / Publish in the action row.

**Four recorded divergences:**

1. **"What changed" is the real diff.** The prototype hard-codes three rows. The third is
   **"Cost impact +$0.06 / run"** — nothing in this prompt computes a cost, and carrying a
   fabricated number forward would be the fixture-as-truth mistake with money attached, which is
   the worst version of it. The section now renders the API's field-by-field and cell-by-cell diff.
2. **The compare ends are selectable.** The prototype's single "Compare V1 ↔ V2" button assumes
   exactly two versions; a real objective can have any number, so both ends are chosen and default
   to the two newest.
3. **The timeline sub-line reports real provenance.** The prototype says "You · today — new draft
   from live"; with a rollback in the history that is simply untrue, so the line says
   "copied from V1" or "rolled back from V1" as the case is.
4. **Publish appears only when something is approved and unpublished.** The prototype always shows
   "Publish V2". Offering it with nothing approved would promise an action the server refuses —
   and after Prompt 20 the server refuses it in the database as well.

**Each version row shows its exact version id** in mono type, because the client requires
historical records to keep them and the screen is where somebody reads one off.

**`objReview()` is not built as its own screen.** The prototype's version is a stub — a heading, a
one-line description and a fixture banner ("2 comments · execution team confirmed") — with
"Request changes" and "Confirm & Analyze" in the action row. Its two real actions are Prompt 20's
`review/send-back` and `review/confirm-team`, both of which are served and tested; the screen that
uses them belongs with the review inbox, which no prompt has specified yet. Recorded here rather
than built from a stub with a fabricated comment count.

### Prompt 21 — Analyze / Generate Workflow: `/objective/analyze`

| Route                | `index.html` counterpart | Effective definition            |
| -------------------- | ------------------------ | ------------------------------- |
| `/objective/analyze` | `objAnalyze()`           | Single definition, at line 887. |

**What was matched:** the reference's `1fr 380px` grid with the objective on the left and the UBoss
analysis panel on the right — which is the prompt's frontend requirement in its own words ("keep
Objective Form on left, open right-side UBoss panel"); the stepper with a marker per stage; the
"Analysis runs as a durable job. You can leave this screen and return — progress is preserved."
note, which is now literally true; the `Cancel (safe)` action; and the node legend with Goal,
Human (rectangle), AI (diamond) and Approval swatches.

**The progress is real.** The reference's own instruction is "no fake completion", and the stage
list comes from the run row rather than a timer. The prototype hard-codes `doneN = 4`; this screen
polls the run while it is in flight and shows where it actually got to, including after a reload.

**Three recorded divergences:**

1. **A prominent warning that no AI provider is configured.** Not in the prototype, and the most
   important thing on the screen: the analysis runs against a **mock model**, and presenting its
   output as a model's judgement would be the fabrication the client's rules forbid. Driven by
   `usesRealModel` from the API rather than a constant, so it disappears by itself when a real
   provider is wired.
2. **The draft's nodes are rendered, with a "what the analysis could not do" section.** The
   prototype's panel ends at "Open workflow draft". Showing the gaps is not decoration — an
   analysis that hid its blind spots would look complete and be wrong.
3. **The estimated AI usage is a range with its basis stated.** The prototype shows no estimate at
   all; `objVersions()` shows a fabricated "Cost impact +$0.06 / run", which is not carried forward
   anywhere. A single figure next to real money reads as a quote, so the range says what it was
   derived from and that the run was a mock.

**Prompt 19's disabled button is now live.** The Objective Form's "Analyze & Generate Workflow"
navigated nowhere and said why; it now links here once the objective is saved (there is nothing to
analyse before that, because the analysis reads the stored Form 2 grid).

**`objWorkflow()` is not built yet.** The prototype's workflow canvas — Form 2 read-only on the
left, the generated flow on the right, with "Add node" and "Assign AI node → Agent Builder" — is
the editor, and Prompt 21's scope is the analysis that produces the draft. The node shapes it needs
are ported into `packages/ui` and exercised by this screen, so the editor inherits them.

## Prompt 22 — `/objective/workflow` and `/objective/prepublish`

Both from the reference's own definitions. `index.html` defines `objWorkflow()` twice, at line 903
and line 1819; the later one is effective, and it is the one implemented — Form 2 on the **left**
at `300px`, the flow on the **right**, which is also the locked Prompt 20–24 rule.

### `/objective/workflow`

- Legend first: Goal, Human work (rectangle), AI work (diamond), Approval / condition — the
  reference's four swatches, wording included.
- Left column: Form 2 read-only, with the objective, owner, workload and the numbered steps.
- Right column: the flow on the reference's dotted `.uboss-canvas`, nodes stacked with connectors.
  A Goal pill, human rectangles, AI diamonds and gate-shaped approvals; the shape comes from the
  node's stored `shape`, never from the component's own opinion.
- Selecting a node opens a drawer carrying every manager action the client listed: title, owner,
  the four narrative parts of the Definition of Done, the approval kind, the trigger event for a
  Trigger node, Human ↔ AI conversion, and delete. The Goal's drawer says why it cannot be deleted
  or converted instead of showing disabled buttons with no explanation.
- Below the canvas, the connection list names each edge's kind as a badge — failure in danger tone,
  IF/ELSE in purple, parallel in cyan.
- Actions, in the reference's order: **Add node**, **Assign AI node → Agent Builder** (disabled;
  Agent Builder is Prompt 24), **Pre-Publish** as primary.
- An assigned plan shows a warning banner and every input is read-only.

### `/objective/prepublish`

The reference's readiness screen: metric cards for the counts, then a readiness table answering its
five checks from the real summary. **Back**, **Test workflow** and **Approve & Assign** are present
as the client named them; the latter two are disabled, because Prompt 23 owns the transaction.

Deliberately **not** carried forward from the prototype: its `Est. AI cost / run $0.42` and its
"dept budget OK" assertion. Both are fabricated in the reference. The cost is shown as the range
the server actually derived, with its basis; no budget claim is made until there is a budget to
read.

### CSS added to `@uboss/ui`

`.uboss-canvas` — the reference's dotted diagram surface. The workflow node, legend and swatch
classes were already ported. Nothing new was invented: the tokens `--uboss-cyan-ink` and
`--uboss-warning-border` already held the reference's exact `#0876a8` and `#e4b063`.

## Prompt 23 — `/todo`, `/todo/detail`, and Approve & Assign

### `/todo` — the reference's Pending Jobs table

Columns as the reference has them: Task, Type, Objective, Due / trigger, Status. The toolbar's
three segments — My work, Team, Blocked — search, and a status filter.

**Deliberately not "To-do & Approvals".** The reference titles this screen that way and mixes
approval rows into the same table. It is one of the reference's recorded defects, and the locked
rule is explicit: never merge To-do and Approvals, never show Approvals twice. This screen is a
person's own work; the Approvals queue is its own sidebar entry, built by the Approval Engine
prompt. The `Type` column stays, always reading `Human`, because the Agent and Approval rows live
on their own screens.

The **Due / trigger** column shows a date when there is one and the triggering event when there is
not — a dash would throw away a real answer. An overdue banner appears above the table when
anything is late, because the count is what makes somebody open the screen.

### `/todo/detail` — the reference's `todoDetail()`

Two columns, as the reference has them. Left: the task, its status badge, "Objective … · Assigned
by … · Due …", then What to do / Input / Expected output / Evidence. Right: the Activity panel
naming Dependency, Approval and Blocker, then **Submit & complete** and **Mark blocked**.

Three actions the client's list names and the reference omits are added in the reference's idiom:
**Start**, **Add Evidence**, and **Comment/Clarify** as two buttons on one field. Where an approved
numbered prompt names a required action, the screen has to offer it.

Two things the screen says out loud rather than leaving implicit:

- **Submit is disabled with the requirement quoted** when the step required evidence and none is
  attached. The server refuses it either way; saying so on the screen means the person finds out
  while they still have the file to hand.
- **"Submitting sends this for a Head decision rather than completing it"**, when the step has an
  approval. A button labelled "Submit & complete" that does not complete would otherwise be a
  small lie.

A finished task shows no actions and says why: a completed task that turns out to be wrong is
re-assigned rather than re-opened, because its evidence and timestamps are what a performance
record reads.

**Evidence is a reference, not an upload**, and the field hint says so. UBoss does not store the
file; it records where the evidence lives.

### `/objective/prepublish` — Approve & Assign is now live

The button was present and disabled at Prompt 22; it now runs the transaction. It is **enabled
even when the summary reports blockers**: the server is the authority on readiness and revalidates
everything inside its transaction, and a button disabled by a client-side copy of that judgement is
how a manager ends up unable to publish a plan that is actually fine. Pressing it either assigns
everything or returns every reason it refused.

On success a banner reports what was created — tasks assigned, AI steps awaiting Agent Builder
setup, approvals queued — and the readiness summary reloads. **Test workflow** stays present and
disabled; nothing can execute a workflow until the Run Engine prompt.

## Agent Builder — `/agent-builder` (Prompt 24)

Follows the reference's `agentBuilder()`: a `1fr 320px` grid. Left card carries the readiness
banner, *Inherited from objective (read-only)*, then *Missing setup (only what's needed)*. Right
card is *Readiness* with **Test agent** and **Activate agent**.

The screen renders exactly the questions the server reports in `missing`, in that order — it does
not decide for itself what to ask. When `missing` is empty it says so and offers Test / Activate,
which is the client's ZERO-QUESTION RULE met literally.

Deliberate departures from the prototype, both because the prototype asserted things the product
cannot know:

- The destination is rendered from the company's own recorded answer rather than a hard-coded
  "SPM — Spain Tenders" option.
- The prototype's `Est. AI cost / run $0.42` is not carried forward. A per-run figure before a run
  has happened is a number nobody can stand behind.

Two things the screen states rather than implies: whether the last test ran against a real
provider or the built-in mock, and that a healthy connection is not yet this agent's permission to
use it. A `uboss-notice-min` line closes the readiness card: *"A connection is chosen by identity.
No credential is ever shown on this screen."*

## Engine Agents — `/agents` (Prompt 25)

Follows the reference's `SCR.agents`: the info banner ("Engine Agents are reusable AI workers.
Individual executions live under Runs."), then a card whose toolbar carries a search field and the
primary **Build agent** to `/agent-builder`, over the table — Agent, Owner, Status, Schedule /
trigger, Last run, Health, Cost. Selecting a row opens the detail drawer, which is as far as the
reference's `agentDetail()` reaches at this prompt.

Two deliberate departures from the prototype, both for the same reason — it asserted things the
product cannot yet know:

- **Health renders "Unknown", not a green badge**, and **Cost renders an em dash**, for an agent
  with no runs. The prototype showed a health badge and a cost on every row. A fabricated 100%
  health is worse than an empty cell precisely because it is the cell an operations person would
  trust without checking.
- **Run now** and **Open runs** are present and disabled, with the reason in the tooltip. They are
  offered because the status genuinely permits them; they do nothing because the run engine is the
  next prompt (ADR-122).

The drawer shows every version with whether it is in force, and — when a draft is open — what it
would change and each reason an approval is required, so the person who has to approve reads the
justification rather than a yes/no.

Pause asks for a reason before it will proceed, because the server requires one: an agent that
stopped for no recorded reason is the state nobody can act on.

## Runs (Prompt 26)

No screen yet — the API and the engine are complete, and the registry drawer's **Run now** and
**Open runs** buttons remain disabled pending the wiring. That is deliberate sequencing rather
than an oversight: the routes now exist and are tested, and enabling two buttons against a tested
API is presentation work, whereas shipping a runs screen fed by an untested engine would have been
the wrong order.

What the screen will show when it is wired, all of it already served by `GET .../runs/meta`:

- The thirteen states with their tones, so a blocked run does not read as a failed one.
- **Who resolves each kind of block** — the reason `BlockedByBudget`, `BlockedByConnection`,
  `BlockedByPermission` and `BlockedByProvider` are four states and not one with a reason code. A
  screen that said only "blocked" would leave every one of them waiting for somebody to guess
  whose problem it was.
- Which transport is carrying the work, because "does my queue survive a restart?" should not be
  answered by reading deployment configuration.

Live progress arrives through `RunProgressGateway`, and the screen will re-read the run on
reconnect rather than trusting its accumulated messages — the event history is the record and the
stream is the convenience.

## Executor — Exception Center — `/executor` (Prompt 27)

Follows the reference's `SCR.executor`: the warning banner, then a card whose toolbar carries a
chip per exception kind, over the table — Work item, Type, Owner, Severity, Age, State. Selecting
a row opens the detail, the reference's `exceptionDetail()`.

The banner carries the client's own wording, and the screen is arranged around the boundary it
states. Every action offered comes from the server's `availableActions` rather than a local list,
so a screen cannot offer something the service will refuse — and the history says, per entry,
whether **the Executor Agent** or **a person** did it.

Three details that are deliberate rather than incidental:

- **An unowned exception shows the source document's default owner for its kind**, not an empty
  cell. "Unassigned — connection owner or company admin" answers whose problem it is even when
  routing could not name an individual.
- **The age column marks overdue explicitly**, computed from the exception's own stored escalation
  window rather than from current policy, so a policy change cannot retroactively relabel history.
- **A closed exception offers nothing**, and says why: reopening would rewrite a resolution
  somebody recorded, and a recurrence raises a new exception instead.

`uboss-chip` was added to the UI package for the filter bar. It is the reference's `.chip` plus a
pressed state driven by `aria-pressed`, so the accessible state and the visible state cannot
disagree — the prototype's chips were static and never had to show which filter was active.

## `/approvals` — the Approval Queue (Prompt 28)

The reference's `SCR.approvals` and `approvalDetail()`, implemented rather than reinterpreted.

- **Title and description are the reference's own words**: "Approval Queue" / "Decisions from
  objective, agent, output, budget and guest flows."
- **The toolbar is the reference's**: a `Pending | Delegated | Decided` segmented control and an
  "Aging shown" chip. Counts appear as **badges**, never concatenated into the label.
- **The table columns are the reference's**: Subject, Decision type, Requester, Risk, Age — plus
  Status, because the reference's queue only ever showed pending rows and the Decided tab needs to
  say what the verdict was.
- **The decision view** is the reference's Approve / Send back / Reject with a reason box.

### Every button comes from the server

The decision buttons are rendered from `available[]`, and the disabled tooltip is the server's own
sentence — including "You cannot approve something you created", which is the mandatory platform
separation-of-duties control talking. There is **no permission logic on this screen at all**: a
screen that decides for itself what a person may approve is a second authorization engine with no
tests.

### What the screen makes visible rather than hiding

- **An escalation says it decided nothing** — "attention only; nothing was decided" — because an
  escalated row otherwise reads like something happened to the request.
- **A four-eyes gate says so** in a warning banner, and says that whoever raised it cannot decide
  it, so a blocked approver understands the refusal before they hit it.
- **A delegate is told they are acting as one**, and that the record will say so.
- **A settled request states that the decision is final** and that a correction is a new request
  pointing back at this one. The supersedes/superseded ids are both shown when present, so the
  chain is readable.
- **"Addressed to" is spelled out**, including the misconfigured case: a request naming neither a
  person nor a role reports itself as such rather than looking merely unassigned.
- **`Governed by`** shows `<module>:Approve`, which is how a reader tells "I cannot see this" from
  "I can see it but this is not my decision".

### Risk is presentation only

The Risk column comes from `APPROVAL_TYPE_RISK`. Five of the eight levels are transcribed from the
reference's own `APPROVALS` sample rows; the other three are reasoned in the vocabulary's comment.
Nothing authorizes off it — every approval decision exercises the same `Approve` action, which
`HIGH_RISK_ACTIONS` already treats as high-risk uniformly, so the column has to distinguish
*between* approvals rather than classify the act of approving.

No new CSS was needed: `uboss-seg`, `uboss-chip`, `uboss-kv`, `uboss-field` and
`uboss-notice-min` already existed. Note `uboss-seg` marks the active button with `is-on`, not
`on`.


## `/master/providers` — Providers & Models (Prompt 29)

The reference's `MSCR.providers`: title "Providers & Models", description "Provider health and
model gateway.", crumb "Providers", four KPIs, then the provider table.

### Two KPIs are shown as unavailable, on purpose

The reference's KPIs are Providers, Models, p95 latency and Fallbacks. The first two are counts of
real rows. The second two would be computed from recorded gateway calls — and with no provider
configured, every call is answered by the mock adapter in zero milliseconds. **They read
"— needs real provider calls" rather than "0ms" or "240ms"**, because a dashboard number taken from
mock calls is a number somebody will quote in a meeting.

### Status is lifecycle plus what the last test established, not "Healthy"

The reference's Status column reads "Healthy". Nothing here can say that: health means a provider
answering and none has ever been contacted. The column shows the lifecycle state and, beneath it,
one of "never tested" / "provider answered" / "tested — no provider reached" — with
`reachedProvider` distinguished from `ok`, which is the distinction S-188 exists to keep.

A warning banner states plainly that no credential is configured, that every call is recorded as
`producedByRealModel = false`, and that the Anthropic and OpenAI adapters are implemented and have
never reached a provider.

### What the drawer will not show

The stored secret. It says "Stored in the vault" or "None" — a credential shown once is a
credential in a browser's memory, and no endpoint returns one.

### The logical profile card

Each of the five with the architecture's **own sentence** in the Gateway behaviour column rather
than a paraphrase, its fallback policy as a badge (`NoFallback` in danger tone), and what would
answer — as the **capability**, never the provider or model name. An unroutable profile shows the
reason, which is the sentence the gateway would have refused with.

No new CSS: `uboss-grid`, `uboss-row-2`, `uboss-kv`, `uboss-section-label`, `uboss-notice-min` and
`uboss-mono` already existed.


## Settings › Tokens & Cost (Prompt 30)

The reference's `setTokens()`, implemented as a bespoke panel rather than a list of generic
setting controls — because that is what the reference is.

**It lives in Settings and nowhere else.** The reference states the rule in its own words and the
panel repeats it verbatim: *"These budget widgets belong here in Settings — never duplicated on
the Dashboard."* The Company Dashboard stays the two-slice donut.

### The reference's layout, §20's figures

The reference shows Total allowance, Remaining, a progress bar, a department table and three
actions. §20's "Credit / allowance display" asks for more: Total, Used, **Reserved**, Remaining,
percentage, next reset/expiry and projected exhaustion. The layout is the reference's; the figures
are §20's.

**Reserved is the figure a reader will not expect, and the one that explains the others** —
remaining is the allowance minus what has been spent *and* what is set aside for runs in flight.
Without it the numbers look like they do not add up.

### What is absent rather than invented

- **Projected exhaustion** reads "Not enough spending yet to project one" when nothing has been
  spent, when the period is under an hour old, or when the allowance is gone.
- **Request top-up** and **Reallocate budget** are present and disabled, titled "Arrives with
  Prompt 31". A button that silently does nothing is worse than one honestly marked.
- The progress bar is **capped at 100% width** so an overspend cannot overflow the card, with the
  true percentage in the badge beside it.

### Credit history

Opened on demand, showing every movement with its resulting balance. A reserve and its release
both appear even though they net to zero, and the panel says why. The **logical model profile** is
shown, never a provider name (ADR-144).

**Reconcile** is offered as a button because it is read-only and the answer matters: it says
either that the balance matches the ledger exactly, or how many drifts were found and that the
ledger is the source of truth.

No new CSS: `uboss-grid`, `uboss-row-2`, `uboss-kv`, `uboss-spread`, `uboss-section-label`,
`uboss-notice-min` and `uboss-mono` already existed. The progress bar is two inline-styled divs,
as in the reference.

---

## Settings › Tokens & Cost — the credits panel (Prompt 31)

Rendered **below** the Prompt 30 budget panel rather than on its own screen. The reference's
`setTokens()` already offers "Request top-up", "Reallocate budget" and "Credit history" as
actions on that card; a separate screen would have been a second place a reader looks for the
same subject.

### What the panel will not offer

**Any decision control.** Not a disabled Approve button either — a greyed-out one implies the
permission exists somewhere in this workspace, and it does not. The panel shows the request's
state and Finance's reason, and the only action on an open request is *Withdraw*.

### What it says out loud

- **"This does not take a payment."** In the request drawer and in the API note. Finance reviews
  the request, decides the amount, and records the invoice reference.
- **Finance may approve a different amount.** Said before the request is sent, and shown
  afterwards as "approved X" beneath the requested figure rather than replacing it, so the
  adjustment is visible.
- **The commercial terms are contract terms**, shown read-only with a line naming who to ask.
- **A blocking negative balance** gets a danger banner with the policy's own reason.

### Amounts

Entered in major units because that is how somebody thinks about money, converted to integer
minor units before the request leaves the browser — the money rule everywhere in this codebase.

No new CSS: `uboss-kv`, `uboss-spread`, `uboss-section-label`, `uboss-field`, `uboss-field-hint`,
`uboss-notice-min` and `uboss-mono` already existed.

---

## Settings › Security — the Security Center (Prompt 32)

`index.html`'s `setSecurity()` is four KPI cards — MFA coverage, Active sessions, Admin accounts,
Guests — above a "Recent security events" table. **That shape is kept exactly**: the same four
cards, in the same order, on the first row. §27.1 and the Technical Architecture require seven more
figures and seven named views, so the remaining cards sit on a second row of the same grid and the
views become a segmented control beneath them. Nothing the client approved was redesigned.

**Every card is a link.** A security figure nobody can open is decoration, and the server says
which view each card drills into — so the screen cannot disagree with the API about where "Failed
logins" leads.

**The badge text carries the meaning, not the colour.** A tone renders as *Healthy*, *Worth a
look*, *Needs attention* or *For information*, because a screen read without colour has to be as
informative as one read with it.

### What it says out loud

- **On Active Sessions**: a session belongs to a person rather than to a company, so revoking one
  signs them out of UBoss entirely. Shown as a banner on the view *and* in bold in the revoke
  drawer, before the button.
- **On Agent high-risk actions**: this is what an agent was *permitted* to do; UBoss records no
  tool invocations because no run performs an external tool action yet (ADR-179).
- **In the footer**: the Security Center stores nothing of its own — which is why nobody, here or
  anywhere, can edit or delete what it shows.

### Filters

The time range is a segmented control (24 hours / 7 / 30 / 90 days) and every counted figure is
captioned with the window it covers. The correlation-id filter **appears only on views whose rows
have one**, and clicking a correlation id in the table applies it — the fastest path from "this
event" to "everything from that request". A row's resource is a link where a destination exists
(a person, an Engine Agent, an Objective) and the identifier where none does, because a link that
goes nowhere is worse than no link.

### What it does not offer

No acknowledge, no dismiss, no clear, no delete — the client's requirement is that a company's own
administrators cannot edit or delete these records, and the store enforces it below the
application. The single act is "Sign out", offered only on a live session and only to somebody
holding `settings:Administer`.

"Open my own Login & Security" still links to `/sessions`. That screen is the *person's* own
factors and devices, which is a different question from the company's security history and stays
separate.

---

## Settings › Agent Policy — memory and output feedback (Prompt 33)

One screen for the two halves of one question: what an Engine Agent may keep, and whether what it
produced was any good. The reference's Settings sidebar has one category for this — "Agent Policy" —
and splitting them would make a reader visit two places to answer "should we trust this agent".

### Three cards

**Engine Agent memory** — the four modes as a table, each row showing its §19 rule beneath its
name, what it keeps, who can see it, its classification ceiling, its sharing limits and what
happens when somebody leaves. "Change" opens a drawer. The visibility dropdown offers **only what
the mode may be narrowed to**, because the server refuses anything wider and offering it would be
offering a refusal.

**What the agents are holding** — the records, with a Held / Including deleted toggle. A deleted row
shows its reason and no delete button. The footer says what a deletion does: clears the content,
keeps the record, so "was our data deleted?" stays answerable.

**AI output quality** — the correct-rate, and beneath it the sentence that stops it being
misleading: when no feedback is on real provider output, the card says the percentage says nothing
about a provider's quality yet. Below that, an agent picker and its runs, each row showing whether
**a real provider or the mock model** produced it, the feedback already given, and a "Rate this
output" button — or "Nothing to judge" where the run produced nothing.

### The rating drawer

The output itself, then the four ratings with the descriptions that distinguish them (three
negative ratings a reviewer cannot tell apart produce a dataset of noise), then a correction field
that appears only for the ratings that need one, then optional evidence. A mock-model output carries
a banner saying the rating is still counted and still marked as mock. The provider-training stance
is at the foot of the drawer and on the quality card, in the server's own words.

### What it does not offer

No way to write a memory record — remembering is an agent's act during a run. No way to promote a
rating into an evaluation case from this screen: it needs `settings:Administer`, and the route
exists, but a promote control belongs beside the Skill it would gate rather than beside the rating.

---

## Objective › Outcome review & closure (Prompt 34)

A screen of its own at `/objective/closure`, because §27.1 asks for a *formal* closure and a formal
closure is a document somebody signs. Putting the verdict, the comparison and the signature into
the versions screen — which is about what changed between drafts — would mix "what did we plan"
with "how did it turn out".

### The comparison, labelled with which figures it is

Before a review is written the figures are **live**. Once written they are the **snapshot the
review was signed against**, and the badge says which. That is the visible half of ADR-191: a late
cost settlement changing a signed closure is what the snapshot exists to prevent, and a screen that
quietly showed the newer numbers would hide it.

Expected against actual, target against finished, human tasks, AI cost, agent runs, exceptions —
and under the elapsed-time figure, a line saying it is wall-clock rather than effort and therefore
not comparable with the AI cost beside it (ADR-192).

### What is outstanding, before anything is signed

Blocking problems and merely outstanding ones are both listed, distinguished by icon, with a line
saying that the rest do not prevent a closure and that closing anyway is a decision the review
records.

### The verdict

Four options with the descriptions that distinguish them — including "No longer the right
objective", which is not a failure and says so, because recording it as one would teach companies
to avoid closing objectives honestly. An explanation field appears for every verdict but `Met`.

Once reviewed the card becomes the record: the verdict and SLA badges, the explanation, who
reviewed and who signed, and a line naming **the sign-off rule that was in force when it was
written**.

### Pause

A reason category and a free-text note, asked for *before* the Pause button is pressed rather than
defaulted — a paused objective somebody finds three weeks later needs to say what it is waiting
for. While paused, a banner carries the server's own description of what a pause does. The history
below lists every pause with the days stopped, and says why it keeps them all.

---

## Settings › Knowledge & Data (Prompt 35)

The section already existed in `SETTINGS_SECTIONS` with a note and no panel. It now has one, and it
is §Settings' three subjects in §Settings' order: *"approved knowledge sources, classification /
retention policy where available"*.

### The banner at the top

Names both adapters and carries the redaction stance **verbatim from the server**. Two facts a
company is entitled to know before it answers a compliance question with this screen: what actually
examined its files, and what happens to sensitive content that wants to leave. Written by the
server rather than the client so the screen cannot drift from what the engine does.

### Data controls

The policy as a definition list: the upload limit, how many formats are accepted, the retention
default, and the two ceilings as classification badges. Two ceilings and not one, because
"exported inside the company" and "leaves the company" are different questions (ADR-200).

### Files

A table, and the scan column is the point. Every row carries the scan state **and the words "mock
scanner"** where the verdict came from the mock — on the row, not once in a banner, because a
reader scanning a column of green ticks should not have to remember something they read at the top.
A separate state column says plainly whether anything may read the file.

Uploading is a plain file input: the browser reads the bytes, base64-encodes them in chunks (a
multi-megabyte `String.fromCharCode(...bytes)` overflows the call stack, which only shows up on a
real document) and posts the same request a script would make. A drop zone is a `packages/ui`
primitive somebody will ask for later, not a second upload path built here.

The drawer shows what the file is, what the scan actually said in the server's own words, whether
a real product produced that verdict, its retention and any hold — and takes a mandatory reason
before either destructive act. Placing a legal hold and deleting content are both decisions
somebody may be asked about.

### Approved knowledge sources

A table with an Approve button on drafts only, and a line saying why approving is a different grant
from assembling. The files column shows the count and, when it matters, how many are **not usable**
— because approving a source whose files have not been scanned is approving something nobody has
looked at, and the approver should see that before pressing the button.

Nothing on this screen offers a "vector store", an "index" or an "embedding", because none exists.

---

## Settings › Security — Support & UBoss access (Prompt 36)

Three things in one place, in the order a company needs them.

### UBoss support is asking to access your workspace

**First, because it is the only thing on the panel with a deadline.** A session waiting on the
company blocks a UBoss engineer trying to fix something for them, and a company that never notices
the request has declined it without deciding to.

Each request shows the operator's written reason, the exact module and action scope, and when the
approval expires. Authorize is one click; **Decline asks for a reason before it will send**, because
UBoss has to know whether to ask differently or not at all. Under `NotRequired` the card does not
appear, and under any policy the panel carries the server's own sentence about what a support
session always involves — a written reason, a verified identity, a second approver, a scope, a hard
expiry, a notification — and that there is no bypass.

The card is fetched separately from the rest and **allowed to fail quietly**: it needs
`settings:Administer`, and an Employee reading their own tickets should not see an error about a
panel they were never entitled to.

### UBoss service status

A status badge, one sentence, and the incidents UBoss has published. Each incident shows a severity
badge and **the operator's customer-facing wording** — there is no internal headline to show,
because the server does not send one. The stance is printed underneath in the server's words: a
company sees published incidents and never which internal component is failing.

### Your support tickets

A table anybody in the company can add to. The drawer asks what it is about, a subject somebody can
read in a list, and what happened — with placeholder text that says why a ticket with no detail
costs a round trip.

The ticket drawer interleaves the conversation in time. **Every note it shows is a reply**: the
server never sends an operator's internal note to a company, so there is nothing to filter on this
side, and the panel does not pretend to do the filtering. A finished ticket says so and offers no
reply box.

---

## The Company Workspace Dashboard (Prompt 37)

`/dashboard`. **One donut, two slices, one sentence.**

`DonutDashboard` already existed in `packages/ui` — built at an earlier prompt against this locked
contract, with the two counts as **named numeric props** rather than a `slices[]` array precisely so
a third category cannot be introduced by passing more data. This screen wires it to the server and
adds nothing.

Clicking Agents goes to `/agents`; clicking Pending Jobs goes to `/todo`. Both destinations come
from `/dashboard/meta` rather than being written into the page, so the screen and the contract
cannot drift. Both detail screens already carry a Dashboard button in their page header, which is
the "clear return to Dashboard" the contract asks for.

The one line of text beneath the donut is the **scope sentence** — "Your own work only", "You and
everyone who reports to you, at any depth", "The whole company". It is a legend, not a KPI card:
without it a manager and an employee see two different numbers with no way to tell why.

**What is deliberately absent**, and the page's own comment says so: no `MetricCard`, no table, no
cost or token figure, no notification list, no hierarchy summary, no performance detail. The way
this screen erodes is that somebody adds one useful thing at a time, each defensible alone.

## Reports (Prompt 37)

`/reports`, from the Reports item in the Operations group. This is where the cards and tables the
dashboard must not carry actually live.

A segmented control across the top lists **only the reports the reader may open** — the server
filters the catalogue, and one they cannot read is absent rather than shown empty, because an empty
Approval Aging table says "nothing is waiting" and that is a different answer.

Under the title is **the question the report answers**, not a description of its columns. A report
nobody can state the purpose of is a table.

A period selector on the right, and an **Export CSV button that is simply not there** when the
reader holds no export grant. Its absence is presentation; the 403 on the route is the control.

Summary figures render as a definition list above the table — the aggregate a reader looks at first.
A truncated result shows a warning that explains the row limit rather than quietly serving a
partial answer, and the scope stance is printed under every table so a reader knows the rows are
confined to what they are entitled to see.

---

## UBoss Profile Search (Prompt 37A)

`/profile-search`, from the Administration group. **One field, and that is the design.**

The box takes a UBoss Unique ID, placeholder `UB-XXXX-XXXX`. There is deliberately no name field,
no email field and no "advanced search" — a search that accepted those would be a way to enumerate
people rather than to verify one, and the server's own sentence saying so is printed under the box.

When the company has not switched the feature on, a banner says so and names where to turn it on,
and the button is disabled. Better than a box that looks usable and always returns a 403.

A result is the person's name and ID, then one card per employer: company, designation, a Current
or Past badge, and the period. Under each, one of two things:

* the performance the employer chose to share — badge, score where shared, on-time percentage and
  the approved-reward count with its most recent date; or
* **"This company does not share performance data in portable search."**

Said out loud rather than left blank, because an absent number and a zero are different facts about
somebody's career and a screen that blurred them would be unfair to the person being verified. The
same reasoning gives "Nothing with a due date to measure" instead of 0% where nothing was
measurable.

There are no titles against the rewards — a reward's only label is the Objective it was earned
against, and an Objective is one of the things a portable profile must never carry. The count and
the date are what a verification needs.

The profile stance is printed at the foot, verbatim from the server: what a portable profile
carries, and what it never does.

# CR-03 (Prompt 40A) — the screens

**Every screen in this section now exists.** It was written first as a specification, while only the
APIs were built, and is kept because it turned out to be accurate: what follows is what was built,
and the few places the implementation chose differently are marked **built as**.

The nine screens CR-03 §7 names were opened in a real browser at 1440px and 400px. Six layout faults
were found that way and fixed; two of them — bullet markers on two lists — existed only because a
`<ul>` had been styled as a grid and never looked at.

**What opening them found that no API test could.** `assertMayRun` had no caller: the operator's Run
button enabled itself from `mayRun`, and the run route decided from ownership and answered 404 for
exactly the person CR-03 exists to serve (ADR-251). And `useFocusTrap` depended on `onClose`, so
every modal in the product accepted one character per click (ADR-257). Both are the argument for why
a UI pass is not decoration.

## The sidebar changes for most people

The locked company sidebar is unchanged in **structure**: HOME (Dashboard) / BUILDERS (Hierarchy,
Objective Optimization, Agent Builder) / OPERATIONS (To-do List, Engine Agents, Executor Agent,
Approvals, Reports) / SETTINGS.

What changes is who sees what in it. A **standard Employee** now sees BUILDERS with **Hierarchy
only** — Objective Optimization and Agent Builder are absent, because they hold no grant on either
module and `visibleModules` is derived from the grants they hold. An Admin or Manager sees all
three, unchanged.

This is not a new hiding mechanism and did not become one: the sidebar renders `visibleModules`
exactly as it already did, and the route refuses on the same absent grant. There is no CR-03 special
case in the navigation component, and no role label is read anywhere.

**Built as** one hook, `useCompanyNavigation`, adopted by all 26 company pages. It reads
`/my-access` — an endpoint with no permission of its own, because gating "what am I allowed to do"
behind a permission is circular (ADR-254). It fails **open**: a pending or failed request renders the
full navigation, which is right for a menu and wrong for a control, so `can()` in the same module
leans the other way (ADR-255).

## Access & Permissions — a step in Add/Invite/Edit User

A step, not a new screen, and not a permission grid. Eight capabilities grouped under three
headings — *Run work assigned to them* / *Manage people and assigned work* / *Design objectives and
build agents* — each a checkbox with its own help text, taken verbatim from `GET
/access/capabilities/:userId`.

Three things the screen must get right:

* **A new employee starts with the two Operate capabilities ticked and nothing else.**
  `defaultForNewEmployee` says so; do not re-derive it in the client.
* **A capability the administrator cannot grant is disabled with its `whyNot` shown**, not hidden.
  Hiding it would make the form look complete while quietly withholding an option, and the
  administrator would never learn why.
* **The real grants are available behind a disclosure.** The response carries them; an administrator
  who wants to know what "can build agents" means should not have to ask an engineer.

## Agent Builder — Import / Export, and nothing else moved

The approved form stays exactly as it is: **A. Skill / Job Overview** + **B. One-time Job Method +
Skill Design**, with the compact Save Draft, Test Agent, Activate Agent and View Objective Form
actions. **Do not restore the removed large right action sidebar, and do not reinstate a duplicate
Assigned AI Work block.**

Two controls are added, under a compact **Import / Export** grouping if the toolbar is crowded:

* **Download Job Method Form** — available to anybody who can see the work, including an employee
  who cannot open this screen at all. In practice the download link belongs on the employee's own
  To-do or Engine Agents view as well, because they are the person who will fill it in.
* **Upload Completed Job Method** — builder only, and it opens the import review rather than saving
  straight away.

### The import review

The screen that stops this feature being dangerous. It must show, per row and per column: what will
be saved, what is **Missing**, what is **Invalid**, what is **Ambiguous**, and what arrived in a
column UBoss has no field for (**Unmapped**). Those four are different facts and must look
different — `Unmapped` in particular is feedback about the form rather than a mistake by the person
who filled it in.

Two statements belong on the screen, verbatim from the server: that this saves into a **draft only**
and will not test or activate anything, and the **agent suggestion** — how many Engine Agents these
rows look like, with the reason. A builder who accepts a one-agent design for a thirteen-step
month-end close should have been told.

## Hierarchy and selectors — the photo

Optional everywhere, initials everywhere it is absent. The API returns `initials` on every
response precisely so no screen has to compute a fallback from a name it may not have loaded.

`viewable: false` means a scan has not cleared the file: show the initials, exactly as for "no
photo". The two must be indistinguishable — a distinct "pending scan" state would tell whoever
uploaded it what the scanner is doing.

Upload, preview, replace, remove. **The Add Employee form gains nothing**: no field, no asterisk,
no seventh row. The photo is set after the person exists.

## OPERATIONS → Engine Agents, for an operator

The simple screen, and its simplicity is the requirement: Agent Name, the linked Objective and
assigned work, status, last and next run where relevant, **Run Agent**, View Result, History, and
Report Issue where appropriate.

**No prompts, no JSON, no API keys, no model internals, no configuration.** The API returns exactly
`OPERATOR_VIEW_FIELDS` and a test greps the response for the forbidden words — the screen must not
reintroduce them by reading a different endpoint.

When `canRun` is false, show `cannotRunBecause` as it arrives. It is one sentence naming the
**first** unmet condition, and the order is deliberate: somebody with no share is told only that,
and learns nothing about approval, connections or budget.

## Workspace Chat — under OPERATIONS

Direct and small group conversations. A list ordered by recent activity with unread counts, a
message pane, mentions, timestamps, attachments, and conversation search.

The part that carries the security rule: **a context reference renders from the preview the server
returns, and the two shapes are different components.** `{accessible: true}` gives a title, a
status and a link. `{accessible: false}` gives the stated reason and **must not** render a
placeholder, a spinner, or a greyed-out title — a viewer who cannot see the thing must see a clear
"you do not have access to this", because an empty box reads as a bug and invites somebody to go
looking.

Contextual **Discuss** links belong on Objective, Human Task, Engine Agent, Agent Run, Approval and
Executor Exception.

What the screen must **not** grow, with `excludedByDesign` served from the API so the argument is
to hand: voice, video, a social feed, presence indicators, reactions or GIFs, channels, threads
within threads, or an edit history. And it must not imply live delivery: no "typing…", no live
badge. There is no socket transport bound, and the honest presentation is a refresh.

## What was verified, and how

Nine screens, two widths, eighteen passes: no console errors and nothing scrolling sideways.
The API was intercepted rather than run, so the data was deterministic and could carry the cases
most likely to break a layout — a long agent name, a refused context preview, four kinds of import
problem at once, a person with no photo beside one who has one.

Then the four states a page load cannot reach, because each needs a click: the Access & Permissions
dialog, the import review, View Result / History / Report Issue, and Discuss.

| Screen | CR-03 | Verified |
| --- | --- | --- |
| Users & Access, with the Access dialog open | §1 | ✅ |
| Hierarchy, with avatars | §3 | ✅ |
| Employee profile | §3 | ✅ |
| Agent Builder, Import / Export | §4 | ✅ |
| Import review | §5 | ✅ |
| Engine Agents — Assigned to you | §5 | ✅ |
| Workspace Chat | §6 | ✅ |
| Standard Employee sidebar | §1 | ✅ |
| Admin/Manager sidebar | §1 | ✅ |
| Contextual Discuss, from an exception | §6 | ✅ |

The faults it found, all fixed: bullet markers on the chat message list and the capability list;
context icons rendered on top of their own titles; the operator section touching the banner above
it; "What this allows" rendering as a browser form button; a screenful of whitespace between each
import problem group; and Agent Builder forcing a 400px viewport 534px wide (ADR-258).

### Two places the implementation chose differently

**Access & Permissions in the Add Employee flow appears after the save, not during it.** A
capability is granted to a person, and until the save there is no person. The six mandatory fields
are untouched, which is what §3 actually protects.

**A native `<select>` cannot show a photo.** §3 names selectors alongside Hierarchy and profile;
the person *picker* shows faces, the reporting-manager dropdown cannot and does not.
