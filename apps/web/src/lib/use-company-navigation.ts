'use client';

import { useEffect, useMemo, useState } from 'react';

import { COMPANY_NAV, filterNavigation, type NavGroup, type NavItem } from '@uboss/ui';

import { readRememberedWorkspace } from './active-workspace';
import { boardsApi, dashboardApi, type SpaceSummary } from './api-client';

import { useMyAccess } from './use-my-access';

/**
 * The sidebar this person should actually see — Prompt 40A (CR-03) §8.
 *
 * ## Why every page needs this
 *
 * Before CR-03 every company page rendered the full `COMPANY_NAV`, which was harmless while every
 * role held every module. It is not harmless now: a standard Employee holds no `objective` or
 * `agent-builder` grant, so leaving the items in the sidebar would show them two screens that
 * refuse them — the "hidden navigation is presentation only" rule read backwards.
 *
 * ## It follows grants, never role labels
 *
 * `visibleModules` comes from the server and is derived from whichever modules the person actually
 * holds a grant on. There is deliberately **no** `if (role === 'Employee')` anywhere: a second rule
 * would have to be kept in step with the first, and the two would eventually disagree.
 *
 * ## Fail open, and only for the menu
 *
 * A failed or pending request renders the full navigation. Being generous with a *menu* is right —
 * every route is independently guarded, so the worst case is an item that refuses when clicked,
 * against the alternative of a sidebar that flickers to empty on every page load and looks broken.
 *
 * This is why the hook reads `visibleModules` directly rather than going through `can()`, which
 * leans the other way on purpose.
 *
 * `unavailableNavKeys` is the exception to failing open. It is not a pending answer — it is the
 * server having already run a route's own authorize call and been refused — so it is honoured even
 * while the module list is still loading.
 */
export function useCompanyNavigation(): NavGroup[] {
  const access = useMyAccess();
  const badges = useNavBadges();
  const spaces = useRisSpaces();

  /*
   * Filter first, then attach the numbers.
   *
   * That order matters: a count can never resurrect an item the filter removed, because an entry
   * with no grant is gone before the badge has anything to attach to. The count itself is the
   * server's, taken in this person's own scope by the same endpoint the dashboard uses — so the
   * pill beside Approvals and the number on the dashboard tile are one query, and cannot disagree.
   *
   * Both steps live inside the memo so its dependencies are the honest ones: the access answer and
   * the counts. `filterNavigation` builds a fresh array every call, so computing it outside would
   * make the memo recompute on every render anyway.
   */
  return useMemo(
    () =>
      filterNavigation(
        COMPANY_NAV,
        access?.visibleModules ?? null,
        access?.unavailableNavKeys ?? null,
      ).map((group) => ({
        ...group,
        items: withSpaces(group.group, group.items, spaces).map((item) => {
          const badge = badges.get(item.key);
          return badge === undefined || badge === 0 ? item : { ...item, badge };
        }),
      })),
    [access, badges, spaces],
  );
}

/**
 * RIS, and the spaces this person may actually open underneath it — CR-04.
 *
 * ## Why the spaces belong in the sidebar at all
 *
 * The client asked for RIS to be a dropdown of its own, and for a person to meet their own
 * department's work rather than the whole company's. Those are one requirement: a heading with a
 * single link under it is not a dropdown, and the thing that makes it one is the list of places
 * it leads. Until this existed the sidebar drew "RIS" with no heading (see the note beside the
 * group in `navigation-model.ts` — a group of one is not a group) and the only way to reach a
 * second space was to already be inside the screen.
 *
 * ## The filtering is the server's, not this list's
 *
 * `listSpaces` has already dropped every space belonging to somebody else's department before the
 * answer leaves the API, so nothing here decides what may be seen. That matters: if this file
 * filtered, somebody could type the URL and the sidebar's omission would have protected nothing.
 * What arrives is what this person may open, and this turns it into links.
 *
 * ## Why the plain "RIS" entry stays at the top
 *
 * It is the whole of it — every space at once — and it is where a person lands when they have no
 * particular space in mind. Replacing it with the space list would take away the one view that
 * answers "where is that board again?".
 */
export function withSpaces(
  group: string,
  items: readonly NavItem[],
  spaces: readonly SpaceSummary[],
): NavItem[] {
  if (group !== 'RIS' || items.length === 0 || spaces.length === 0) return [...items];

  return [
    ...items,
    ...spaces.map<NavItem>((space) => ({
      key: `tracker-space-${space.id}`,
      label: space.name,
      // The same icon the tracker's own tree draws beside a space, so the sidebar entry and the
      // thing it opens are recognisably the same object.
      icon: 'grid',
      href: `/tracker?space=${encodeURIComponent(space.id)}`,
      module: 'todo',
    })),
  ];
}

/**
 * The spaces to list under RIS.
 *
 * Read once per screen rather than polled: a space is created by hand, perhaps a few times a
 * year, and a sidebar that re-asks every minute would be spending a request a minute on an answer
 * that almost never changes. The badges above are the opposite case and are polled for it.
 *
 * Failure is silent and leaves the list empty, which is the sidebar exactly as it was before this
 * existed — RIS, with no spaces under it. A menu must never show an error.
 */
function useRisSpaces(): readonly SpaceSummary[] {
  const [spaces, setSpaces] = useState<readonly SpaceSummary[]>([]);

  useEffect(() => {
    const tenantId = readRememberedWorkspace();
    if (tenantId === null) return;

    let live = true;
    void boardsApi
      .listSpaces(tenantId)
      .then((view) => {
        if (!live) return;
        setSpaces(view.spaces.filter((space) => space.archivedAt === null));
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, []);

  return spaces;
}

/**
 * The counts that belong on sidebar entries.
 *
 * ## Why this exists at all
 *
 * The client asked where an administrator sees that an employee has filed a request. The answer
 * was the Approvals screen, and nothing anywhere said to go and look at it — so a request could
 * sit for a day in a queue nobody had a reason to open. A number on the entry is the smallest
 * honest thing that fixes that: it is the count of what is actually waiting, and it disappears
 * when the queue is clear.
 *
 * ## Why it reads the dashboard endpoint rather than a new one
 *
 * Because that endpoint already answers exactly this question, already filters to the modules this
 * person holds, and already counts in their own authorized scope. A second endpoint would be a
 * second answer, and the day the two disagreed the sidebar and the dashboard would be arguing
 * about the same queue.
 *
 * ## Why only three
 *
 * A badge on everything is a badge on nothing. These are the three entries that are queues — work
 * that is waiting for somebody — and the rest are places you go rather than piles that grow.
 */
const BADGED_TILES: Record<string, string> = {
  approvals: 'approvals',
  executor: 'exceptions',
  todo: 'tasks',
};

function useNavBadges(): Map<string, number> {
  const [badges, setBadges] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    const tenantId = readRememberedWorkspace();
    if (tenantId === null) return;

    let live = true;

    const read = () => {
      void dashboardApi
        .counts(tenantId)
        .then((view) => {
          if (!live) return;
          const next = new Map<string, number>();
          for (const [navKey, tile] of Object.entries(BADGED_TILES)) {
            const count = view.tiles.find((entry) => entry.tile === tile)?.count ?? null;
            if (count !== null) next.set(navKey, count);
          }
          setBadges(next);
        })
        /*
         * A sidebar must never show an error. Failing quietly leaves the entries without numbers,
         * which is how they looked before this existed and is a perfectly usable sidebar.
         */
        .catch(() => undefined);
    };

    read();

    /*
     * Re-read when somebody looks at the screen again, and once a minute while they are.
     *
     * Same cadence and the same reasoning as the notification bell: a queue count is not a trading
     * price, and a poll every few seconds across a company's open tabs is real load for a number
     * that usually has not moved. A hidden tab asks for nothing.
     */
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    const timer = setInterval(onVisible, BADGE_REFRESH_MS);

    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
      clearInterval(timer);
    };
  }, []);

  return badges;
}

const BADGE_REFRESH_MS = 60_000;
