# UBoss — Source of Truth

The single reference for locked product rules. Any conflict is resolved by the **latest explicit
functional rule**. Nothing here may be changed to make coding convenient; a new business rule
requires a client decision, recorded in this file with its date.

Last reconciled: 2026-09-08 (Prompt 1).

---

## 1. Authoritative sources

| Rank | Source                                                     | Scope                                                                                                 |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | `UBoss_Final_1_Latest_Client_Approved.docx`                | Company setup, screens, end-to-end worked journey (Form 2 example at §37)                             |
| 2    | `UBoss_Final_2_Latest_Client_Approved.docx`                | Functional product baseline and acceptance checklist; §29–§33 carry the latest client change baseline |
| 3    | `UBoss_Technical_Architecture_Latest_Client_Approved.docx` | Technical architecture and development rules; implements the above without changing behaviour         |
| 4    | `index.html` (repo root)                                   | Client-supplied **exact UI reference** — the approved look, screens and flows                         |
| 5    | `UBoss_Claude_Prompt_Pack_Latest_Client_Approved.docx`     | Build sequence (Prompts 0, 0A, 1–46, plus 12A, 12B, 19A, 37A)                                         |

The Master Prompt cites the first three as `*_Client_Updated.docx`. The files on disk are the newer
`*_Latest_Client_Approved.docx`; they are the same documents at their latest approved revision.

---

## 2. Locked terminology — never substitute legacy agent labels

| Term               | Definition                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Engine Agent**   | The actual reusable AI worker/executor. A recurring Engine Agent is activated **once**; each execution creates a new **Run**, never a new Agent.                                                                                                              |
| **Executor Agent** | The monitoring, validation, exception and escalation layer. It watches Human tasks _and_ Engine Agent Runs, checks evidence/timing/rules, and routes exceptions to the correct owner. It must **never** silently replace or bypass a required Human approval. |
| **Skill**          | A governed, versioned, reusable capability. The **Skill Router** selects only relevant _approved_ Skills.                                                                                                                                                     |
| **Run**            | One monitored execution of an Engine Agent.                                                                                                                                                                                                                   |

---

## 3. Locked product rules

1. Manager enters the Objective using the **existing Form 2 fields**.
2. UBoss generates the Human + AI workflow **from scratch** using Objective, hierarchy, policy and
   approved Skills.
3. **No Templates Library in this baseline.** UBoss generates from live business context. Nothing
   template-shaped may be introduced under another name.
4. Human work goes to **To-do**.
5. AI work goes to **Agent Builder** or an existing approved **Engine Agent**.
6. Nothing becomes actionable until **Approve & Assign**.
7. Any edit after an Objective is **Live** creates a **new Draft Version**. The live version is never
   overwritten.
8. AI cost lifecycle is **Estimate → Reserve → Execute → Settle/Reconcile**.
9. **No plaintext passwords or reusable provider credentials** in normal UI or database fields.

---

## 4. Latest client locked rules (0A change lock)

Reflected in `UBoss_Final_2` §29–§33 and the acceptance checklist.

1. **No public company signup.** The UBoss Master Console provisions customers. "Create Account"
   means activation of an already invited/allotted identity.
2. Login left presentation shows six sections: **MAP, Optimize, Build, Operate, Govern, Manage
   Task**. All six remain until the client approves another grouping. Presentation only — they grant
   no application access.
3. Every authenticated company screen header shows **`UBOSS AI AMS | {Active Workspace Name}`**,
   resolved from authenticated tenant context and never hard-coded.
4. **Company Workspace Dashboard shows exactly one donut/pie chart with two slices only: Agents and
   Pending Jobs.** Counts are permission-scoped. Slices drill down (Agents → Engine Agent list/detail,
   Pending Jobs → permitted pending work) and both offer a clear route back. **No other dashboard
   content**: no KPI cards, objective tables, token/cost cards, notification lists, hierarchy
   summaries, performance details or reports.
5. Hierarchy visibly shows the active company **Vision and Mission**, tenant-isolated, maintained by
   authorized admins.
6. **Add Employee mandatory fields:** Employee Name, Employee ID, Designation, Department, Reporting
   Manager, Aadhaar Number. All other profile fields optional.
7. **Aadhaar is for internal person matching only.** Do **not** implement Aadhaar
   OTP/authentication/verification, and never claim verified Aadhaar status.
8. UBoss creates or links **one permanent UBoss Unique ID** per person across companies; each company
   holds a **separate employment record and company Employee ID**.
9. Authorized **cross-company profile search uses the UBoss Unique ID, not Aadhaar**, and returns only
   the permitted professional summary.
10. **Performance** increases for governed on-time accepted completion and decreases for governed
    late/missed completion, with approved exception handling. Score and badge history is auditable.
11. Baseline badge ladder: **Bronze → Silver → Gold → Platinum → Diamond**; thresholds configurable.
12. Objective/extra work may carry an **optional bonus/reward condition outside canonical Form 2**.
    Eligibility requires defined completion, evidence and approval.
13. **TCSiON user types/allotment are an external client dependency.** Do not invent them. Map the
    approved reference into UBoss authorization when supplied.

---

## 5. CR-01 items that exist only in conversation

Issued 2026-09-07. Items 1, 2, 5, 6, 7 and 8 were subsequently folded into the approved documents.
**The following two are recorded here because no `.docx` contains them** and they would otherwise be
lost:

- **CR-01/3 — No dead-end screens anywhere.** Every screen must offer a next action, Back,
  breadcrumb context, a route to the Dashboard, and detail → parent/list return. All of it permission
  controlled. The UI reference already honours this by pointing stub routes somewhere valid.
- **CR-01/4 — per-role graphical one-page dashboard.** This is **overridden for the Company Workspace
  Dashboard** by rule 4.4 above. `UBoss_Final_2` line 1163 declares "LATEST RULE WINS": the Company
  Workspace Dashboard is the two-slice donut only. The Master Console remains a separate platform
  control plane and may keep its operational KPI dashboard. Do not "restore" summary cards to the
  Company Workspace Dashboard on the strength of CR-01/4.

Also locked by CR-01: fully linked auth screens (Login ↔ Activate/Create Account ↔ Forgot
Password/Access Help ↔ Back to Login, Success → authorized dashboard), and a **TCSiON mapping seam**
of the shape _TCSiON User Type → UBoss User Type/Role → Scope → Module Visibility → Allowed Actions_,
with the backend permission model authoritative.

---

## 6. Non-negotiable engineering rules

- Every tenant-owned backend operation derives tenant context from **authenticated membership** and
  enforces permissions **server-side**. A browser-supplied `tenant_id` is never trusted on its own.
- Every screen implements loading, empty, error, permission-denied and success states where
  applicable.
- Every dangerous action carries confirmation/impact/reason where required, plus an audit event.
- Status is **never colour-only** — always paired with text or an icon.
- No lorem ipsum in final screens. Use realistic UBoss labels and demo data.

---

## 7. Open items awaiting client input

| Item                                    | Current default                                                                                                    | Status                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Five vs six login sections              | Render all six                                                                                                     | **Resolved** — docs say keep all six       |
| Login section descriptive copy          | Use the approved one-liners from `index.html`                                                                      | **Resolved** by the UI reference           |
| `UBOSS AI AMS \| …` on Master Console   | Master Console keeps its own platform identity, no tenant name                                                     | **Confirmed** by `UBoss_Final_2` line 1163 |
| Vision/Mission governance depth         | Admin-maintained field with an audit event on change; no separate approval queue, no Objective-style version chain | Assumption — not contradicted              |
| Vision/Mission visibility for Guests    | External Guests do not see them; workspace name still shown                                                        | Assumption                                 |
| TCSiON user types / allotment reference | Not supplied. Mapping seam built, types not invented                                                               | **Blocked on client**                      |
