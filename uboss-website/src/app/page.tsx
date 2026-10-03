import { ChiefAgentHero } from '@/components/hero/ChiefAgentHero';
import {
  ProductTour,
  SkillsLibrary,
  DepartmentSolutions,
  GovernanceSummary,
  ClosingCTA,
} from '@/sections/WorkforceSections';
import { ApiSection } from '@/sections/ApiSection';
import { Plans } from '@/sections/Plans';
import { FAQ } from '@/sections/FAQ';

/**
 * The single narrative page.
 *
 * The order is an argument, not a list: what it does, how it works, what it does with an
 * objective, who does the work, what governs the AI half, who is in control, what you can see,
 * where it is used, and how to see it for yourself. The `id` on each section is what the nav and
 * the footer link to, so every link on the site lands on something real.
 */
export default function Home() {
  return (
    <>
      <ChiefAgentHero />
      <ProductTour />
      <SkillsLibrary />
      <DepartmentSolutions />
      <GovernanceSummary />
      <ApiSection />
      <Plans />
      <FAQ />
      <ClosingCTA />
    </>
  );
}
