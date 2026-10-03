/*
 * Import the Universal Enterprise Skill Catalog into the platform Skill catalogue.
 *
 * ## What this writes
 *
 *   • 400 platform Skills — 208 `UbossVerified`, 192 `IndustryPack` — each with `tenant_id NULL`,
 *     which `skill_layer_matches_its_owner` requires of both layers and forbids of `CompanyCustom`.
 *   • one `Published` version per Skill, carrying that Skill's rules from the IF-THEN sheet.
 *
 * ## Nothing from the workbook is dropped
 *
 * Every column has a home, and where a mapping is lossy the original is kept beside it:
 *
 *   Skill ID          → `skills.key` (prefix, so the identifier survives and stays unique)
 *   Skill Name        → `skills.name`
 *   Layer             → `skills.layer`
 *   Department        → `skills.department`     (not `category`: 65 chars vs a closed 40)
 *   Industry          → `skills.industry`       (IndustryPack only — a CHECK enforces that)
 *   Archetype         → `skills.archetype`, and mapped onto `skill_versions.category`
 *   Purpose           → `purpose`
 *   Positive Trigger  → `when_to_use`
 *   Do Not Use        → `when_not_to_use`
 *   Minimum Inputs    → `inputs[]`              (split on `;`)
 *   Primary IF/THEN   → `rules[0]`, marked as the primary
 *   Output            → `output_schema`
 *   Validation Gate   → `validation`
 *   Autonomy          → `autonomy` enum + `source_autonomy` verbatim
 *   Source IDs        → `source_reference`
 *
 * And from the IF-THEN sheet, per rule: Rule ID, Condition Type, IF, THEN, Priority, Evidence
 * Required, Failure State, Human Gate, Source IDs — all onto the rule record.
 *
 * `failure_handling` and `evidence_requirement` are columns the schema requires and the catalogue
 * sheet does not carry. They are **derived from that skill's own rules** — the distinct failure
 * states and evidence demands its rules name — rather than invented or filled with a placeholder.
 *
 * ## Idempotent
 *
 * Keyed on `skills.key`, which `one_platform_skill_key` makes unique across the platform. A second
 * run updates rather than duplicating, and reports what it changed.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const WORKBOOK = process.argv[2] ?? 'Universal_Enterprise_Skill_Catalog_IF_THEN (1).xlsx';
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Reading the workbook
// ---------------------------------------------------------------------------
//
// Parsed here rather than with exceljs, which refuses this file: every element is
// namespace-prefixed (`x:worksheet`, `x:row`) and there is no workbook rels part in the shape the
// library expects. The parts themselves are ordinary OOXML.

function extract(workbook) {
  const out = fs.mkdtempSync(path.join(process.env['TEMP'] ?? '/tmp', 'skillcat-'));
  execFileSync('unzip', ['-q', '-o', workbook, '-d', out], { stdio: 'pipe' });
  return out;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

function columnIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) ?? ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheet(root, file) {
  const xml = fs.readFileSync(path.join(root, 'xl/worksheets', file), 'utf8');
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:x:)?row[^>]*>([\s\S]*?)<\/(?:x:)?row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:x:)?c([^>]*)>([\s\S]*?)<\/(?:x:)?c>/g)) {
      const ref = cellMatch[1].match(/r="([A-Z]+\d+)"/)?.[1] ?? 'A1';
      const type = cellMatch[1].match(/t="([^"]+)"/)?.[1] ?? 'n';
      const inner = cellMatch[2];
      const value =
        type === 'inlineStr'
          ? [...inner.matchAll(/<(?:x:)?t[^>]*>([\s\S]*?)<\/(?:x:)?t>/g)].map((t) => t[1]).join('')
          : (inner.match(/<(?:x:)?v[^>]*>([\s\S]*?)<\/(?:x:)?v>/)?.[1] ?? '');
      cells[columnIndex(ref)] = unescapeXml(value).trim();
    }
    rows.push([...cells].map((c) => c ?? ''));
  }
  const header = rows[0] ?? [];
  return rows.slice(1).map((row) => {
    const record = {};
    header.forEach((name, i) => {
      record[name] = row[i] ?? '';
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Mapping the workbook's vocabularies onto the product's
// ---------------------------------------------------------------------------

const LAYER = {
  'Universal Department': 'UbossVerified',
  'Industry Overlay': 'IndustryPack',
};

/**
 * Archetype → the nine-value `SkillCategory`.
 *
 * Lossy by construction — twelve onto nine — which is why `skills.archetype` keeps the original.
 * Each mapping is to the category that governs the same kind of work, never to a default.
 */
const CATEGORY = {
  'Analyst / Scorer': 'Analysis',
  'Planner / Optimizer': 'Analysis',
  'Validator / Auditor': 'Review',
  'Workflow / Orchestrator': 'Operations',
  'Generator / Document': 'Drafting',
  'Monitor / Detector': 'Analysis',
  'Extractor / Normalizer': 'DataEntry',
  'Router / Intake': 'Operations',
  'Governance / Approval': 'Compliance',
  'Communicator / Follow-up': 'Communication',
  'Research / Discovery': 'Research',
  'Integrator / Synchronizer': 'Operations',
};

/**
 * Autonomy → the four-value enum, failing closed.
 *
 * Nothing in the catalogue authorises acting without approval, so nothing reaches `ActThenReport`
 * or `FullyAutonomous`. A level this does not recognise becomes the most restrictive rather than
 * the most permissive, and the run reports it.
 */
const AUTONOMY = {
  'A1 — Read / analyze': 'SuggestOnly',
  'A2 — Draft / recommend': 'SuggestOnly',
  'A3 — Write only after approval': 'ProposeForApproval',
  'A4 — Human authority required': 'ProposeForApproval',
};

/** A lower-kebab key the `skill_key_is_lower_kebab` CHECK accepts, carrying the source id. */
function keyFor(skillId, name) {
  const kebab = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const head = kebab(skillId);
  const tail = kebab(name);
  return `${head}-${tail}`.slice(0, 80).replace(/-+$/, '');
}

const splitList = (value) =>
  value
    .split(/;|•/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** The distinct values a skill's rules give for one column, in the order they first appear. */
const distinct = (rules, field) => [
  ...new Set(rules.map((rule) => (rule[field] ?? '').trim()).filter((v) => v !== '')),
];

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(WORKBOOK)) {
    throw new Error(`Workbook not found: ${WORKBOOK}`);
  }

  const root = extract(WORKBOOK);
  const catalogue = readSheet(root, 'sheet3.xml');
  const ruleRows = readSheet(root, 'sheet4.xml');

  console.log(`workbook: ${catalogue.length} skills, ${ruleRows.length} IF-THEN rules`);

  const rulesBySkill = new Map();
  for (const rule of ruleRows) {
    const id = rule['Skill ID'];
    if (!rulesBySkill.has(id)) rulesBySkill.set(id, []);
    rulesBySkill.get(id).push(rule);
  }

  const problems = [];
  const seenKeys = new Map();

  const prepared = catalogue.map((row, index) => {
    const at = `row ${index + 2} (${row['Skill ID']})`;
    const layer = LAYER[row['Layer']];
    if (layer === undefined) problems.push(`${at}: unknown layer "${row['Layer']}"`);

    const category = CATEGORY[row['Archetype']];
    if (category === undefined) problems.push(`${at}: unknown archetype "${row['Archetype']}"`);

    const autonomy = AUTONOMY[row['Autonomy']];
    if (autonomy === undefined) problems.push(`${at}: unknown autonomy "${row['Autonomy']}"`);

    const key = keyFor(row['Skill ID'], row['Skill Name']);
    if (seenKeys.has(key)) {
      problems.push(`${at}: key "${key}" collides with ${seenKeys.get(key)}`);
    }
    seenKeys.set(key, at);

    const mine = rulesBySkill.get(row['Skill ID']) ?? [];
    if (mine.length === 0) problems.push(`${at}: no IF-THEN rules`);

    // The primary IF/THEN from the catalogue sheet, then every rule from the rules sheet.
    const rules = [
      {
        when: row['Primary IF'],
        then: row['Primary THEN'],
        conditionType: 'Primary',
        sourceIds: row['Source IDs'],
      },
      ...mine.map((rule) => ({
        when: rule['IF'],
        then: rule['THEN'],
        ruleId: rule['Rule ID'],
        conditionType: rule['Condition Type'],
        priority: rule['Priority'],
        evidenceRequired: rule['Evidence Required'],
        failureState: rule['Failure State'],
        humanGate: rule['Human Gate'],
        sourceIds: rule['Source IDs'],
      })),
    ].filter((rule) => rule.when.trim() !== '' && rule.then.trim() !== '');

    const failureStates = distinct(mine, 'Failure State');
    const evidence = distinct(mine, 'Evidence Required');

    return {
      sourceId: row['Skill ID'],
      key,
      name: row['Skill Name'],
      layer,
      industry: layer === 'IndustryPack' ? row['Industry'] : null,
      department: row['Department'] || null,
      archetype: row['Archetype'] || null,
      ruleCount: mine.length,
      content: {
        purpose: row['Purpose'],
        category: category ?? 'Analysis',
        whenToUse: row['Positive Trigger'],
        whenNotToUse: row['Do Not Use / Exclusions'],
        inputs: splitList(row['Minimum Inputs']).map((name) => ({
          name: name.slice(0, 160),
          description: name,
          required: true,
        })),
        rules,
        /*
         * The procedure, stated as what this catalogue actually is.
         *
         * The workbook carries no numbered steps — it is an IF/THEN catalogue, and the rules
         * *are* the procedure. An empty list was the first reading, and it was wrong in a way
         * that only showed up against the product's own validator: `validateSkillContent`
         * refuses a Skill with no step ("a capability with no procedure is a wish"), so four
         * hundred imported Skills would have been unable to complete an edit cycle — the first
         * approval of any new draft would be refused until somebody wrote a step by hand.
         *
         * So the steps restate the catalogue's own structure rather than inventing a procedure:
         * check the trigger, check the inputs, apply the rules, meet the validation gate. Each
         * one names the workbook field it came from, so a reviewer can see it is a restatement.
         */
        steps: [
          {
            order: 1,
            instruction: `Confirm this is the right Skill for the work: ${row['Positive Trigger']}`,
          },
          {
            order: 2,
            instruction: `Confirm the required inputs are present: ${row['Minimum Inputs']}`,
          },
          {
            order: 3,
            instruction:
              `Apply this Skill's IF/THEN rules in priority order. Primary rule — ` +
              `${row['Primary IF']} ${row['Primary THEN']}`,
          },
          {
            order: 4,
            instruction: `Meet the validation gate before producing the output: ${row['Validation Gate']}`,
          },
        ],
        // The catalogue declares no tools. Declaring none is fail-closed: a Skill that needs one
        // is granted it by a ConnectionToolGrant, and declaring Read here for four hundred Skills
        // would be asserting something the client never wrote down.
        allowedToolCategories: [],
        outputSchema: row['Output'],
        validation: row['Validation Gate'],
        failureHandling:
          failureStates.length > 0
            ? `Failure states this Skill's rules define: ${failureStates.join('; ')}.`
            : 'Stop and route for a decision; do not write on a failed rule.',
        requiresApproval: true,
        autonomy: autonomy ?? 'ProposeForApproval',
        sourceAutonomy: row['Autonomy'] || null,
        evidenceRequirement:
          evidence.length > 0
            ? evidence.join('; ')
            : row['Minimum Inputs'] || 'The inputs this Skill declares.',
      },
      sourceReference:
        `Universal Enterprise Skill Catalog — ${row['Skill ID']}; standards ${row['Source IDs'] || 'not stated'}`.slice(
          0,
          500,
        ),
    };
  });

  const totalRules = prepared.reduce((sum, skill) => sum + skill.ruleCount, 0);
  console.log(`prepared: ${prepared.length} skills, ${totalRules} rules attributed to a skill`);

  if (problems.length > 0) {
    console.error('');
    console.error(`${problems.length} problem(s) — nothing written:`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('dry run — nothing written');
    return;
  }

  // -------------------------------------------------------------------------

  // Required only once something is going to be written, so `--dry-run` validates the workbook
  // on a machine with no built API and no database.
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { PrismaPg } = require('@prisma/adapter-pg');

  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('DATABASE_URL is not set.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  // Who publishes a platform Skill: UBoss. The publication constraints require an attributed
  // approver and publisher, and the honest one is the platform owner.
  const publisher = await prisma.$queryRaw`
    SELECT u.id FROM users u
    JOIN platform_role_assignments p ON p.user_id = u.id
    WHERE u.is_platform_actor = true LIMIT 1`;
  const publisherId = publisher[0]?.id ?? null;
  if (publisherId === null) {
    throw new Error('No platform actor exists to attribute the publication to.');
  }

  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const skill of prepared) {
    /*
     * One interactive transaction per Skill, and the platform flag set inside it.
     *
     * `set_config(..., true)` is transaction-local. Outside a transaction every Prisma call is its
     * own implicit one, so the flag was gone before the very next statement ran and the insert met
     * the row-level security policy with nothing set — "new row violates row-level security policy
     * for table skills", which is the policy doing its job. The flag has to live in the same
     * transaction as the writes it authorises.
     */
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_operation', 'on', true)`;

      const existing = await tx.skill.findFirst({
        where: { tenantId: null, key: skill.key },
        select: { id: true },
      });

      const skillRow = existing
        ? await tx.skill.update({
            where: { id: existing.id },
            data: {
              name: skill.name,
              layer: skill.layer,
              industry: skill.industry,
              department: skill.department,
              archetype: skill.archetype,
            },
          })
        : await tx.skill.create({
            data: {
              tenantId: null,
              key: skill.key,
              name: skill.name,
              layer: skill.layer,
              industry: skill.industry,
              department: skill.department,
              archetype: skill.archetype,
            },
          });

      const { sourceAutonomy, ...content } = skill.content;

      const versionRow = await tx.skillVersion.upsert({
        where: { skillId_versionNumber: { skillId: skillRow.id, versionNumber: 1 } },
        create: {
          tenantId: null,
          skillId: skillRow.id,
          versionNumber: 1,
          status: 'Published',
          ...content,
          sourceAutonomy,
          creationMode: 'FromDocument',
          sourceReference: skill.sourceReference,
          approvedByUserId: publisherId,
          approvedAt: now,
          publishedByUserId: publisherId,
          publishedAt: now,
        },
        update: {
          ...content,
          sourceAutonomy,
          sourceReference: skill.sourceReference,
        },
      });

      if (skillRow.publishedVersionId !== versionRow.id) {
        await tx.skill.update({
          where: { id: skillRow.id },
          data: { publishedVersionId: versionRow.id },
        });
      }

      if (existing) updated += 1;
      else created += 1;
    });
  }

  console.log('');
  console.log(`created ${created}, updated ${updated}`);

  const counts = await prisma.$queryRaw`
    SELECT layer::text AS layer, count(*)::int AS n
    FROM skills WHERE tenant_id IS NULL GROUP BY layer ORDER BY layer`;
  for (const row of counts) console.log(`  ${String(row.n).padStart(4)}  ${row.layer}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
