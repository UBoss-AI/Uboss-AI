import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Keep the DOM isolated between tests so state cannot leak across assertions.
afterEach(() => {
  cleanup();
});
