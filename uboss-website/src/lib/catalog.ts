/**
 * Figures and names taken from the UBOSS Skill Catalog as it is actually persisted.
 *
 * Every number here was read from the running platform catalogue on 23 September 2026, not
 * estimated and not rounded for effect:
 *
 *   select layer, count(*) from skills where tenant_id is null group by layer;
 *     UbossVerified 208 · IndustryPack 192                                  → 400
 *   select sum(jsonb_array_length(rules)) from skill_versions v
 *     join skills s on s.id = v.skill_id
 *     where s.tenant_id is null and v.status = 'Published';                 → 2800
 *   select count(distinct industry) from skills where tenant_id is null;    → 24
 *
 * The brief asked for "2,400 IF-THEN rules". The catalogue holds **2,800**, so that is what the
 * site says. A marketing number that disagrees with the product is the one kind of claim a
 * customer can check in the first demo.
 *
 * Anything that cannot be read from the product does not belong in this file. There are no
 * customer counts, no revenue figures, no uptime percentages and no certifications here, because
 * there are none to read.
 */

export const CATALOG = {
  /** Platform-level Skills, shared across companies and entitled per tenant. */
  skills: 400,
  /** Governed IF-THEN rules carried by those Skills' published versions. */
  rules: 2800,
  /** Skills that apply to any company, whatever it makes. */
  ubossVerified: 208,
  /** Skills that belong to one industry's way of working. */
  industryPack: 192,
  /** Industries with a pack of their own. */
  industries: 24,
} as const;

/** The catalogue's own categories, with the count each one actually holds. */
export const CATEGORIES: readonly { name: string; count: number; blurb: string }[] = [
  {
    name: 'Analysis',
    count: 252,
    blurb: 'Read a situation and say what it means, with the evidence it was read from.',
  },
  {
    name: 'Operations',
    count: 49,
    blurb: 'Carry a repeatable operational step, inside the policy that governs it.',
  },
  {
    name: 'Review',
    count: 44,
    blurb: 'Check work against a standard and report what does not meet it.',
  },
  {
    name: 'Drafting',
    count: 21,
    blurb: 'Produce a first version for a person to decide on. Never the last word.',
  },
  {
    name: 'DataEntry',
    count: 17,
    blurb: 'Move structured information between systems without retyping it.',
  },
  {
    name: 'Compliance',
    count: 7,
    blurb: 'Test an action against the rule that constrains it before it happens.',
  },
  {
    name: 'Communication',
    count: 6,
    blurb: 'Prepare what goes to somebody else, in the form they expect it.',
  },
  {
    name: 'Research',
    count: 4,
    blurb: 'Gather what is known about a question and cite where it came from.',
  },
];

/** Real Skills from the catalogue, used as examples rather than invented ones. */
export const SAMPLE_SKILLS: readonly {
  name: string;
  department: string;
  category: string;
}[] = [
  {
    name: 'Access Review',
    department: 'IT, Cybersecurity & Service Management',
    category: 'Review',
  },
  { name: 'Accounts Payable Control', department: 'Finance & Accounting', category: 'Operations' },
  {
    name: 'Accounts Receivable Collections',
    department: 'Finance & Accounting',
    category: 'Analysis',
  },
  {
    name: 'Anti Bribery Due Diligence',
    department: 'Regulatory, Legal & Compliance',
    category: 'Analysis',
  },
  {
    name: 'Asset Lifecycle Planner',
    department: 'Maintenance, Assets & Utilities',
    category: 'Analysis',
  },
  {
    name: 'AI Use Case Classification',
    department: 'Data, Analytics & AI',
    category: 'Operations',
  },
];

/** The industries the catalogue actually carries a pack for. */
export const INDUSTRIES: readonly string[] = [
  'Aerospace & Defense',
  'Agriculture & Agribusiness',
  'Auditing, Certification, Inspection & Labs',
  'Automotive & Mobility',
  'Banking, Insurance & FinTech',
  'Chemicals & Process Manufacturing',
  'Construction, EPC & Real Estate',
  'Education, Training & Research',
  'Electronics & Semiconductors',
  'Energy, Oil, Gas & Utilities',
  'Food & Beverage',
  'Healthcare, Hospitals & Diagnostics',
  'Hospitality, Travel & Events',
  'Logistics, Warehousing & Cold Chain',
  'Media, Advertising & Creative',
  'Medical Devices & IVD',
  'Mining & Minerals',
  'Pharmaceutical & Biotech',
  'Professional Services & Consulting',
  'Public Sector & Government',
  'Retail, E-commerce & Consumer Goods',
  'Software, SaaS & IT Services',
  'Steel & Metals',
  'Telecom & Network Services',
];
