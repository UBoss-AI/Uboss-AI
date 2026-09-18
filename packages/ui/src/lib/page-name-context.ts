'use client';

import { createContext } from 'react';

/**
 * Whether something above this point is already displaying the page's name.
 *
 * ## Why a flag and not the name itself
 *
 * The shells show the current section in the top bar, in the place the product name used to sit.
 * That made every screen say its own name twice — once in the bar and again in the page heading
 * underneath it, which is what the client asked to be rid of.
 *
 * So `PageHeader` needs to know whether its title is redundant, and the answer is a property of
 * the surroundings rather than of the page. A shell sets this to `true`; a screen rendered outside
 * one — the internal platform pages have no shell at all — never sees it and keeps its heading.
 * That is the whole reason this is a context and not a prop: the 45 places that render a
 * `PageHeader` do not have to know, and cannot get it wrong, and a page added later inherits
 * whichever behaviour is correct for where it is rendered.
 *
 * It carries a boolean rather than the name because the shell derives the name itself, from the
 * navigation item matching its `activeKey`. Reporting it upward from here was the other option and
 * it is worse in two ways: the name would arrive in an effect, a frame after the bar had already
 * painted without it, and pages that render more than one `PageHeader` across their loading and
 * loaded states would decide the bar's contents by whichever effect ran last.
 *
 * `false` is the safe default. A `PageHeader` with no shell above it behaves exactly as it always
 * has, so nothing can silently lose its heading by being rendered somewhere unexpected.
 */
export const PageNameShownAboveContext = createContext(false);
