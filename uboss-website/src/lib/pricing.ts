// Quote-based engagement options. No unapproved prices, limits or SLAs are implied.
export const PLANS = [
  { name: 'Pilot', number: '01', description: 'Start with one meaningful workflow.', price: 'Custom pilot quote', audience: 'FOR YOUR FIRST USE CASE', features: ['One clearly defined business objective', 'A scoped agent and skill configuration', 'Guided workflow demonstration', 'An agreed path to evaluate the outcome'], cta: 'Discuss a Pilot', featured: false },
  { name: 'Business', number: '02', description: 'Coordinate work across departments.', price: 'Team rollout quote', audience: 'FOR MULTIPLE TEAMS', features: ['Workflows across your departments', 'Relevant industry and company skills', 'Human approvals and execution visibility', 'Usage and onboarding scoped to your needs'], cta: 'Discuss Your Rollout', featured: true },
  { name: 'Enterprise', number: '03', description: 'Plan a governed organization-wide rollout.', price: 'Enterprise quote', audience: 'FOR A COMPANY-WIDE ROLLOUT', features: ['Organization-wide rollout planning', 'A review of your governance requirements', 'Agreed usage and support arrangements', 'A tailored implementation conversation'], cta: 'Talk to Sales', featured: false },
] as const;

export const PRICING_COMPARISON = [
  ['Starting scope', 'One use case', 'Multiple teams', 'Organization-wide'],
  ['Workflows and agents', 'Scoped for the pilot', 'Agreed with your team', 'Tailored to the rollout'],
  ['Skills and industry packs', 'Relevant to the use case', 'Selected for your departments', 'Selected for your organization'],
  ['Human control', 'Included in the workflow design', 'Included in the workflow design', 'Included in the workflow design'],
  ['AI usage and allowances', 'Defined in your quote', 'Defined in your quote', 'Defined in your quote'],
  ['Onboarding and support', 'Agreed before you start', 'Agreed before you start', 'Agreed before you start'],
] as const;
