'use client';

import { ModuleShell } from '../_components/ModuleShell';

/**
 * Development & Operations — shipped as a shell this prompt.
 *
 * The content, including what specifically blocks it, comes from the API's `module-status`
 * endpoint so it cannot drift from what the server says. See `ModuleShell`.
 */
export default function Page() {
  return <ModuleShell navKey="dev-ops" title="Development & Operations" />;
}
