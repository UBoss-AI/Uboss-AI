# Open defects

Problems found by driving the product, not by reading it. Each one says what happens, why it
happens, and how it was found, so that whoever picks it up does not have to rediscover any of
that. Nothing here is fixed yet.

Opened 2026-10-07, from an end-to-end run: a 25-step month-end reconciliation filled into the
Objective template offline, uploaded, saved, and analysed.

---

## 1. The workflow editor cannot be reached from the Analyze screen

**Severity: high.** It is the step that comes next, and there is no way to take it.

The analysis finishes, the draft workflow is drawn, and the person is looking at a read-only
diagram. There is nothing on that screen that leads to editing it.

A full editor exists — `apps/web/src/app/objective/workflow/page.tsx` — with **Add node**, an
**Edit** panel per node, and Pre-Publish. Searching the whole web app for `objective/workflow`
finds exactly one link to it, on the Pre-Publish screen
(`apps/web/src/app/objective/prepublish/page.tsx:219`). The Analyze screen has none.

So the order the product actually supports is: analyse → (no route) → … → Pre-Publish → edit.
Somebody who wants to correct a node the analysis got wrong has to already know the URL.

**Fix:** a link from the Analyze screen to the editor, beside the draft, once a draft exists.

**Note the pattern.** This is the third time in this codebase that a working feature was built and
never drawn: `RunAgentPanel` and its two routes (no Run control anywhere), and `setSkills` plus
`skills/for-builder` (no Skills control in Agent Builder). Both were found the same way — by
driving the screen rather than reading the code. Worth a sweep for others.

---

## 2. The draft workflow diagram is unreadable at real size

**Severity: medium.** It is correct and it cannot be used.

With 29 nodes the diagram is a single narrow column. "Pull the branch cash submission file for the
month" wraps onto five lines inside its box. Reading a 29-node plan means scrolling through a
column of tall, thin cards; the shape of the workflow — which is the only reason to draw it rather
than list it — is not visible.

Drawn by `renderNode` in `apps/web/src/app/objective/analyze/page.tsx` (the `uboss-wf-*` classes).

**Fix:** give the nodes room — wider boxes, a layout that uses the horizontal space, and a way to
see the whole plan at once. The Hierarchy chart already has zoom, fit-to-width and full-screen
controls; the same problem has been solved on that screen.

---

## 3. Twenty-five gap lines are printed as a flat list

**Severity: medium.** The information is right and the presentation defeats it.

The analysis records every decision it could not make, which is the correct behaviour — see §4
below for why it refuses to guess. But on this run it produced 25 of them, printed one under
another, and the screen becomes a wall of near-identical sentences:

```
Step 2 names nobody, so no owner could be assigned to it.
Step 3 names nobody, so no owner could be assigned to it.
Step 6 names nobody, so no owner could be assigned to it.
…
```

Two different causes were mixed into one list: fifteen steps that named nobody, and ten that named
somebody outside the objective owner's team. Those need different actions from the reader, and the
list does not separate them.

**Fix:** group the gaps by kind, show a count and one example per group, and let the full list be
opened. The two causes above should read as two findings, not twenty-five.

---

## 4. Not a defect: the owner is left unassigned on purpose

Recorded here so it is not "fixed" by mistake.

`ObjectiveAnalysisService` (`apps/api/src/objectives/objective-analysis.service.ts`, around line 676) matches the name in a step's **Person Name** column against the objective owner's team. A name
it cannot match is left unassigned and a gap is recorded, with the reason in the gap's own words:

> Step 4 names "Meera Iyer", who is not in the objective owner's team on record. The owner was left
> unassigned rather than guessed at.

That is deliberate: assigning the wrong person is worse than assigning nobody. On the run above the
25 steps named people from three different departments while the objective had one owner, so ten
of them could not be matched — a property of the test data, not of the product.

**What is worth deciding:** whether naming somebody outside the owner's team should be an error at
upload time, when the person filling the sheet can still fix it, rather than a gap discovered after
the analysis has run.

---

## 5. Every step needs a name, including the AI ones

Recorded because it is easy to get wrong, and the product does not say so anywhere.

The **Person Name** column is not only for steps a person performs. The analysis assigns an
accountable owner to **Human and AI nodes alike**, and the code says why:

> An AI node has no person performing the work, but it does have an accountable one … Leaving AI
> nodes unowned made that prefill fall back to the objective owner for everything, which put every
> agent's setup in front of the manager instead of the employee the plan named.

So an AI step with no name means that agent's setup lands on the manager rather than on whoever
owns the work. On the run above, fifteen AI steps were left blank and all fifteen would have gone
to the manager.

Nothing on the template or the grid tells somebody this. The column heading reads as "the person
doing it", which is exactly the reading that leaves AI rows empty.

**Fix:** say it where it is filled in — in the template's own guidance and beside the column on the
grid — that an AI step names the person accountable for it.

---

## 6. The analysis stages arrive all at once instead of unfolding

**Severity: low — it is how the run feels, not what it does.** Asked for directly.

All seven stages are drawn the moment the run starts, as a finished-looking list that then fills in
with ticks. What is wanted is the list revealing itself: the active stage carrying a spinner and its
number, each completed stage settling into a green tick with a smooth transition, and the header
changing from **Running** to **Completed** when the last one lands.

Drawn by `ProgressStep` (`packages/ui/src/primitives/ProgressStep.tsx`) from the `stages` array the
Analyze screen builds at `apps/web/src/app/objective/analyze/page.tsx:334`. The component already
has a `uboss-step-pulse--live` state for the active row, so the live marker exists; what is missing
is the entrance and the transition between states.

**Two things this must not borrow from the brief it was asked in.**

- **The delay must come from the run, not a timer.** The brief suggests 800–1500 ms between steps
  "to simulate real AI processing". The server already reports real progress — `stage`,
  `stagesCompleted` and `stages[].state` on the analysis run — and the screen already polls it. An
  animation driven by `setTimeout` would show seven stages completing on a schedule whether or not
  the analysis is doing anything, including while it is stuck or has failed. That is a progress bar
  that lies, and it falls under the rule against presenting work that did not happen. Animate the
  **transition** between the states the server reports; never the advance from one stage to the
  next.
- **The stack is this one.** The brief names Tailwind classes and Lucide icons; this product has
  neither. Animation is `motion/react` with the design system's own motion tokens, icons come from
  the `Icon` primitive, and the visual states are `uboss-*` classes. A new looping animation needs
  its own motion token rather than reusing an existing one.

Worth keeping while doing it: a run that fails or is cancelled has to be as legible as one that
succeeds, so the stage that was in flight should stop rather than spin for ever.

---

## Fixed in this pass

**The Objective template did not state the Time Unit vocabulary.** The Steps sheet writes its
accepted words into a legend row under the headings; the Objective sheet has a Notes column and
used it only to mark two routing fields, so Time Unit — the one closed list on that sheet — went
out with nothing beside it. "Days" is the obvious word and is not one of them, so the whole form
was filled in before the save came back with `Time unit must be one of: WorkingDays, CalendarDays,
Hours, Weeks`. The Notes column now carries that list.
