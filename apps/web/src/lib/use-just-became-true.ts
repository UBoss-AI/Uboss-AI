'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Notice the moment a gate opens.
 *
 * `readyToTest` and `readyToActivate` are answers the server computes from real setup, and they
 * flip while you are looking at something else on the page — you resolve a connection in another
 * panel, the readiness poll comes back, and a button that was dead is now live. Nothing on screen
 * says so. The control simply looks different from how it looked when you last glanced at it, and
 * the most common outcome is that people do not notice and go looking for what else is wrong.
 *
 * So this reports the *transition*, not the state: true only for the render after a false becomes
 * true, and never on first mount. A cue on mount would be announcing something that did not just
 * happen, which is the whole failure mode this is meant to avoid.
 *
 * Cleared by the caller when the cue finishes, so the flag cannot outlive what it marks.
 */
export function useJustBecameTrue(value: boolean): [boolean, () => void] {
  const previous = useRef<boolean | null>(null);
  const [fired, setFired] = useState(false);

  useEffect(() => {
    // First observation establishes a baseline and announces nothing.
    if (previous.current === null) {
      previous.current = value;
      return;
    }
    if (previous.current === false && value === true) setFired(true);
    previous.current = value;
  }, [value]);

  return [fired, () => setFired(false)];
}
