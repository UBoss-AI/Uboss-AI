# CXO design audit — why the product reads as generic

Snapshot: 14 October 2026, local HEAD `e22fcfa`. Written for the people who will do the redesign.

This audit exists because the client said three things: the UI is generic and has no layout, the
Objective flow and the workflow that follows it are not good, and there is no animation. None of
those is actionable as stated, so this is an attempt to turn them into measurements.

Two halves: a source pass over all 62 routes, and a browser pass signed in as a Company Admin.
Nothing was changed to produce it.

## 0. Four measurements that were wrong first time

Recorded because each was wrong in the same direction — a narrow scan read as a finding — and
anyone repeating this work will make them again.

| First answer                              | Why it was wrong                                                  | Real answer                                                     |
| ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| "Only 4 of 62 screens have any visual"    | Only `page.tsx` was scanned; visuals live in imported components  | 11 of 35 company screens render a real visual                   |
| "The Objective flow has no stage shown"   | Only `ProgressStep` was searched for                              | `StatusBadge` is on all 7 screens; the **journey** is not       |
| "Only 6 of 35 screens have empty states"  | `emptyTitle` is a `DataTable` prop, not an `<EmptyState>` element | 16 pass one explicitly, and every `DataTable` renders a default |
| "The internal console is better composed" | Same `page.tsx`-only scan, applied to both planes                 | 31% company against 33% master — no gap at all                  |

## 1. The shape problem, which is what "generic" means

Four sections were opened in a browser at 1280×529: Objective Optimization, Approvals, To-do List,
Engine Agents. Their structure is identical:

```
title bar
(sometimes one blue explanatory banner)
toolbar row — search, and a filter or segmented tabs
┌──────────────────────────────────────┐
│  one wide card                       │
│  a centred empty state inside it     │
└──────────────────────────────────────┘
```

Nothing in that composition says which section it is. A screen about approving work and a screen
about AI workers are the same rectangle with different words in it. **That is the complaint.** It
is not a shortage of charts — it is that every section has the same silhouette, so the product
reads as one screen repeated twelve times.

Two screens break the pattern and are the most designed in the product:

- **Hierarchy** carries Company Vision and Company Mission above the chart, a tree/list toggle and
  a wider set of actions.
- **Reports** frames itself as questions — "What is AI work costing?", "How much of the work is AI
  doing?" — rather than as a list of report names.

## 2. Composition, counted

62 routes: 35 company, 18 Master Console, 3 internal, 6 design-system reference.

Of the 35 company screens, **11 render a real visual component** — `OrchestrationMap`, `OrgChart`,
`WorkflowCanvas`, `WorkflowGrid`, `ReportChart`, `ProgressRing`, `ProgressStep`, `MetricCard`,
`BadgeProgression`, `JobMethodGrid`, `DashboardAmbience`. The other 24 are tables, cards and forms.

| Plane                    | Screens | Render a visual component |
| ------------------------ | ------- | ------------------------- |
| Company workspace (sold) | 35      | 11 — 31%                  |
| Master Console (ours)    | 18      | 6 — 33%                   |

The two planes are the same. An earlier draft of this audit claimed the internal console was
"better composed than the product being sold" — 28% against 11% — and that was an artefact of
counting only what `page.tsx` renders directly, which misses every visual that arrives through an
imported component. Corrected, there is no gap, and the sentence has been removed rather than
softened: it was a good line and it was not true.

What survives the correction is the plainer fact that **two of three company screens render no
visual at all**, which is the measurement that matters.

## 3. Motion exists and is tuned to be invisible

The design system defines 28 keyframes, and motion also arrives through shared primitives — Tabs,
Toast, SegmentedControl, DonutDashboard, ProgressStep. So "there is no animation" is not true.

What is true is the calibration. The scale in `tokens.css`:

| Token                      | Duration | Intent                       |
| -------------------------- | -------- | ---------------------------- |
| `--uboss-motion-micro`     | 100ms    | hover, focus, press          |
| `--uboss-motion-small`     | 160ms    | selection, row change, toast |
| `--uboss-motion-panel`     | 240ms    | dropdown, popover, tab       |
| `--uboss-motion-large`     | 320ms    | drawer, dialog, route        |
| `--uboss-motion-signature` | 480ms    | donut draw, workflow reveal  |

The page entry animation moves 6px over 240ms. The workflow node reveal runs at 240ms and its
connectors at 160ms. All of that is correct for software somebody uses for eight hours and wrong
for ninety seconds of demo. There is exactly **one** signature duration in the scale and almost
nothing claims it.

The accurate version of the client's complaint is **"there are no signature moments"**, and the
fix is three or four deliberate ones, not faster micro-interactions.

## 4. The Objective lifecycle: modelled, half-used, barely shown

`ObjectiveStatusKind` has 12 states: Draft, UnderReview, AiAnalysis, WorkflowDraft,
ReadyForApproval, Active, Paused, Completed, OutcomeReview, Closed, Archived.

What the local database has actually reached:

| State            | Versions |
| ---------------- | -------- |
| WorkflowDraft    | 26       |
| Draft            | 21       |
| Active           | 15       |
| ReadyForApproval | 8        |
| AiAnalysis       | 1        |
| UnderReview      | 1        |
| Paused           | **0**    |
| Completed        | **0**    |
| OutcomeReview    | **0**    |
| Closed           | **0**    |
| Archived         | **0**    |

**The entire second half of the lifecycle has never happened once.** No objective has been paused,
completed, had its outcome reviewed, been closed or archived. When the client says the workflow
"after" the objective is not good, that is the literal truth of the demo: there is no after.

On the screens, across all seven Objective routes:

- `StatusBadge` appears on all 7 — the current state is always shown.
- `ProgressStep` appears on 2 — analyze and versions.

So a person is told the objective is in `WorkflowDraft`. They are not told that this is the fourth
of eleven steps, which three are behind it, or what happens next. The backbone is in the database
and stops before the screen.

## 5. Two defects worth fixing regardless of any redesign

**Company Mission renders a numbered list as one run-on paragraph.** On `/hierarchy`, above the
chart, the mission reads: `1. EXPONENTIAL GROWTH 2. WORLD-CLASS PRODUCTIVITY 3. FOCUSSING ON
PROFITABILITY 4. EVERGREEN COMPLIANCE 5. ...` — six numbered items, in capitals, with no line
breaks, in a single block. It is the first thing on the company's own screen and it cannot be read.

**The Reports tab strip wraps to three rows.** Thirteen report names in one strip at 1280px wide.
Nothing is broken; it is simply unscannable.

## 6. What to do, in order

1. **Give the Objective journey somewhere to be seen.** A stage rail carried across all seven
   screens, showing the eleven steps, what is done, where you are, what is blocked. The component
   to build it from exists; it is applied on two screens out of seven.
2. **Take the demo data through the second half of the lifecycle.** Complete some objectives,
   review their outcomes, close them. This is a data change, not a code change, and it is the only
   way the client can see the part of the product they are complaining about.
3. **Give each section a silhouette of its own.** Not all 24 screens — the ones a demo opens:
   Approvals, Engine Agents, Executor, To-do, RIS. A summary band above the table that answers
   "what should I look at", so the section is recognisable before it is read.
4. **Three or four signature moments.** Workflow reveal, analysis completing, an approval being
   granted. One new duration token, used deliberately.

Items 1 and 2 address what the client named. Item 3 addresses what they described. Item 4
addresses what they asked for by name, and is the smallest of the four.
