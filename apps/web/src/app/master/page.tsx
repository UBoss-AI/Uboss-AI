import { redirect } from 'next/navigation';

/**
 * `/master` lands on the Platform Overview.
 *
 * A redirect rather than a duplicate dashboard: the reference's router defaults
 * `master` to `master/dashboard`, and two routes rendering one screen is two
 * places to keep in step.
 */
export default function MasterIndexPage() {
  redirect('/master/dashboard');
}
