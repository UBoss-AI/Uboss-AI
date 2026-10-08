# What a person finds using this product

Written by going through the product the way somebody would on their first day: sign in, look at
the dashboard, add a person to the hierarchy by hand and then by spreadsheet, build an objective
by hand and then by spreadsheet, and carry on from there.

Each entry says what was done, what happened, and why it is a problem — not just that something
is missing. Entries marked **fixed** were resolved in the same pass.

---

## 1. A dashboard tile opens its card below the fold

**Doing this:** sign in, land on the dashboard, click the **Objectives** tile at the top of the
Execution & Setup column.

**What happens:** nothing visible. The tile does work — it opens a card listing the live
objectives with an **Open Objectives →** button — but that card is rendered underneath the whole
tile grid and the orchestration diagram, several screens down. At the default window height the
page does not move, so the click produces no feedback at all.

**Why it matters:** this is the first thing anybody does on the dashboard. A tile that appears
inert is a tile people press twice and then stop pressing. The feature is finished; only its
result is out of sight.

**Fix:** scroll the card into view when a tile opens it, or place it where the eye already is.

**Fixed.** The card is scrolled into view when a tile opens it.

---

## 2. Arranging tiles works, and the drag has one surface it cannot reach

**Doing this:** dashboard → **Arrange** → drag a tile, then try the arrow keys.

**What happens:** the mode explains itself well — "Drag a tile to move it, or use the arrow keys:
left and right move it, up and down make it large or ordinary … A tile stays in its own group."
The keyboard path works: pressing the right arrow on **Objectives** moved it from first to second
and **Tasks** took its place.

**What is worth knowing:** moving by mouse is HTML5 drag-and-drop, which does not fire for touch
input at all. On a tablet or a touch laptop, dragging a tile does nothing and the screen gives no
reason — the hint names the keyboard, but somebody using a finger has no keyboard to reach for.

**Not a defect today**, because the product is used on desktops, and the keyboard and double-click
paths both work. Recorded because the day it is opened on a tablet, the tiles will look broken in
exactly the way they were reported broken once before.

---

## 3. The people search box is narrower than its own placeholder

**Doing this:** open **Hierarchy** and look at the toolbar.

**What happens:** the search input reads `Search peop` — the placeholder is cut off mid-word.

**Why it matters:** it is the first thing on a screen that lists a company's whole staff, and a
control that cannot fit its own label reads as unfinished. It also sits in a row with seven other
controls, so the row is the thing to give room, not the box alone.

**Fixed.** `.uboss-search` keeps a 190px minimum, and the rows it sits in already wrap, so a
crowded toolbar moves it to its own line instead of cutting the words in half.

---

## 4. The two dashboard columns are badly out of balance

**Not fixed — the client wants to decide the approach. Recorded with the options.**

**Doing this:** look at the dashboard at any window size.

**What happens:** Execution & Setup holds seven tiles and Oversight holds four. Each lane is a
single flex column, so the left runs a long way past the right and the space beside the lower half
of the diagram is empty. Nothing is wrong; it simply looks unfinished.

**Why it is structural:** a tile's lane is the server's answer — work that is set up versus work
that is reviewed — and tiles deliberately cannot be dragged across. The imbalance is therefore a
property of the company's permissions, not something a person can tidy away.

**Four ways out, with what each costs:**

1. **Make each lane a grid rather than a column.** `repeat(auto-fit, minmax(240px, 1fr))` turns
   seven tiles into two columns of four and four into two of two; both lanes end up short and
   level. Needs the lanes to be wider than they are today.
2. **Move the Chief Agent core out of the middle.** It is what keeps both lanes narrow. As a
   header strip it would free the width that (1) needs. Costs the "everything connects here"
   reading, and the core's placement comes from the locked UI reference — a client decision, not
   a developer one.
3. **Start the Oversight tiles large.** The size toggle already exists (Arrange, up/down arrow);
   defaulting the four oversight tiles to large makes them fill the height the seven on the left
   occupy. Almost no new code. It is a per-person, per-company setting, so a new company would
   still see the uneven version until somebody set it.
4. **Let the shorter lane stretch.** `justify-content: space-between`, or the tiles growing to
   fill. Pure CSS and nothing else changes; the cost is more empty space inside each tile as the
   gap between lane lengths grows.

**Recommended:** (3) with (4) — the two lanes level out on one screen, the meaning of a tile does
not change, and almost nothing new is written. (1) and (2) together look best and mean changing
where the core sits, which is the client's call.

---

## 5. "Optional details" contained two required fields

**Doing this:** Hierarchy → **Add Employee**, scroll to the bottom of the dialog.

**What happened:** under a heading reading **OPTIONAL DETAILS** sat **Email \*** and **Phone \***,
both carrying the required asterisk. The comment three lines above the heading states the client's
rule — "exactly six fields are mandatory, and every other profile field is optional and must not
show an asterisk" — and the screen broke it immediately below.

This was self-inflicted: the asterisks were added earlier in this same pass, correctly, because
the service has refused an employee without an email or phone since CR-04. What was not done was
moving them out of a section that then described them wrongly.

**Fixed.** Email and Phone sit with the required fields. They were not unstarred to match the
heading — the service does require them, and the heading was the thing that was wrong.

---

## 6. The reporting manager picker is a flat list with no search

**Doing this:** Add Employee → **Reporting Manager**.

**What happens:** every currently-employed person in the company in one `<select>`, as
`Name — Designation`. With thirty-three people it is already a long scroll; the order is neither
alphabetical overall nor labelled by department, so finding a particular manager means reading
down the list.

**Why it matters:** this is the field that decides where somebody sits in the org chart, and it is
the one field on the form that gets harder as the company grows. At two hundred people it is a
list nobody can use, on a form that otherwise takes a minute.

**Worth doing:** the same search-and-pick control the rest of the product uses for people, or at
minimum group the options by department so the list reads as the chart does.

---

## 7. An admin cannot see a person's performance, and the screen does not say why

**Doing this:** open any employee's profile → **Performance**.

**What happens:** "Not shown — you do not have access to this person's performance record." The
person reading it here is a Company Admin.

**What is unclear:** whether that is the intended rule. If performance is deliberately private
even from an administrator, the sentence should say so — "performance records are private to the
person and their manager" is a policy somebody can accept. As written it reads as a permission
that was meant to be granted and was not, on the account that has every other permission.

**Not changed:** this is a policy question, not a bug to fix unilaterally.

---

## 8. The import template was four tabs for a one-tab job

**Doing this:** Hierarchy → **Download Excel template**, then open the file.

**What happened:** four sheets. `Employees` is the one to fill in. `Departments` and `People` were
lists to copy values out of. `Photographs` was nine lines of prose. And on the sheet that mattered,
row 1 held the headings and row 2 held long grey explanatory notes — two rows that both look like a
header, on a file whose first instruction is "start typing".

**Why it mattered:** the two reference sheets existed because the importer matches a department and
a manager by exact name, so people were given lists to copy from. Copying by hand is still typing:
the spelling could still be got wrong, and then the row was refused for a reason that reads like
the product's fault. The second header row is worse than clutter — somebody either types into it or
deletes it, and it is the row the reader is looking for to know what to skip.

**Fixed, and the lists did not just disappear.** Department and Reporting Manager are now dropdowns
built from this company's own records at the moment the file is downloaded, so a value is picked
rather than recalled. The guidance that filled the other sheets sits on the headings as cell
comments — read where somebody is typing, not on a tab they have to think to open. One visible
sheet is left, plus a hidden one holding only the lists.

The dropdown warns rather than refuses. A file may name a manager created by an earlier row of
itself, and a company about to add a department has a reason to type one that is not there yet —
the server decides both, and says which row and why.

**And every heading now carries a star, which meant making two of them true.** The client asked for
a star on all of them. A star on this template is a promise that the server refuses the row
without it, so two columns had to change rather than just gain an asterisk:

- **Reporting Manager** was already refused when blank — once a company has somebody at the top,
  the importer rejects a row without one. The template had said it was optional for as long as that
  rule has existed. This is the third time this exact gap has been found in this file.
- **Specialization** was genuinely optional in the import and required on the form. It is now
  required in both. The column stays nullable in the database: a question nobody was asked has no
  honest answer but "we do not know".

**Verified** by downloading the real file from the running product: one visible tab, nine headings
all starred, row 2 empty, dropdowns carrying this company's nine departments and thirty-six people.
Filling it from those dropdowns and uploading it gave `1 ready and 0 refused`, then `1 added` — and
the person arrived with their specialization and their manager. A template saved before this change
still imports as one person rather than two, because the note row is still recognised.

---

## 9. Vision and Mission were the wrong way round

**Doing this:** open **Hierarchy** and read the two cards above the chart.

**What happened:** Mission was drawn on top and Vision underneath.

**Why it matters:** a Vision is where the company is going and a Mission is what it does every day
to get there. In that order the Mission answers the line above it; reversed, it is a statement that
arrives before its own question.

**Fixed.** Vision is drawn first. The Mission keeps its own darker gradient wherever it sits — the
colour belongs to the panel, not to the position. The editor dialog was reordered to match, because
a dialog that asks for them in one order while the strip shows them in another makes somebody check
whether they typed them the wrong way round.

---

## 10. The Import dialog explained the file the file now explains, and offered a download twice

**Doing this:** Hierarchy → **Import**.

**What happened:** a dialog with two primary buttons — **Download Excel template** and **Upload
filled template** — and underneath them nine bullets, one per column, each repeating that column's
note. The longest thing in the dialog was a description of a file.

**Two separate problems, both from the same habit of saying everything everywhere:**

The download was already on the toolbar directly behind the dialog. Pressing **Import** to be
offered **Download** is a moment spent deciding which of two identical routes was meant, on a
screen where the answer is "either".

The nine bullets were the only readable summary of the columns while the file's own guidance sat in
a grey row people skipped. Now that each heading carries its note as a comment, the bullets are a
word-for-word second copy — and two copies of the same guidance is one that disagrees with the
other eventually. The copy worth keeping is the one in front of somebody while they are typing.

**Fixed.** The dialog does one thing: **Choose filled template**. Three lines say what the file
wants, and the way back to the template is a line of text rather than a second button, for somebody
who opened this without it. The request that fetched the column list on every open went with the
bullets; `hierarchyTemplateColumns` is untouched on the server.

**Verified** in the browser: the dialog is a third of its former height, and the text link really
downloads the template.

---

## 11. Five statuses rendered with no colour, and three things that should have caught it did not

**Doing this:** open **Objective Optimization** and read the status column.

**What happens:** `Draft` is a grey pill. **`Workflow Draft` is bare text** — same column, same
component, no pill at all.

**Why:** the tone was `'cyan'`, and no stylesheet has ever defined `uboss-badge--cyan`. A tone
becomes a class name, so an unknown word produces a class nothing matches: nothing throws, nothing
logs, the badge simply renders unstyled. Four other statuses carried it too, among them **`Running`
— the status people look at most** — plus `InProgress`, a reward's `Completed`, and a run's
`Running`.

**Three checks looked straight at it:**

- the maps were typed `Record<Status, string>`, and `string` accepts any word;
- every screen cast the value on the way in — `as StatusTone` — which tells the compiler to stop
  asking;
- the test asserted `TONES[status].length > 0`, and `'cyan'` is four characters long.

Each was looking at whether a tone had been written down, not at whether the one written exists.

**Fixed, in the order that matters:**

1. The vocabulary is closed in `@uboss/types` as `StatusTone`, and all eleven `*_TONES` maps are
   typed against it — the compiler now refuses a colour that does not exist.
2. The thirteen `as StatusTone` casts are gone, so a future mismatch surfaces where it is written.
3. The five `cyan` entries are `teal`, which the canonical vocabulary already uses for exactly this
   meaning (`Running: 'teal'`, `Analyzing: 'teal'`) — no new colour was needed.
4. A test reads `components.css` and asserts every tone has a rule and every rule has a tone. That
   is the check nobody had written, and it is the only one that would have caught this.

---

## 12. The AI analysis asked a model seven questions and read none of the answers

**This is the largest thing in this document.**

**Doing this:** press **Run Objective** and watch the seven stages.

**What happened:** `ObjectiveAnalysisService.ask()` was declared `Promise<void>`. It built a
request, called the Model Gateway, added the token counts to the run — and discarded the reply.
Seven stages, seven real completions, seven answers no line of code read. The workflow was then
assembled deterministically from the grid the company had typed, and presented as the analysis's
conclusion.

The stage named `'Classify which steps are human work.'` asked the question and then did this:

```ts
const human = state.steps.filter((step) => step.whoEngine === 'Human');
```

The person's own column. The model was asked and overruled by a filter.

**Why it matters beyond the waste:** a company is billed for those calls at the sell rate. More
seriously, the screen says the AI is analysing, and the plan somebody approves carries the
authority of a judgement nothing made.

**What the client asked for, and what was built:**

Somebody writing an objective says which machine layer a step belongs to — Engine, Sub-Engine or
Executor — and the analysis works out which part of that work a model can do and which part a
person must. In the client's words: _"user manually us person ka kaam thodi likhe ki ye human
karega — objective agent jab chalega khud decide karega uske kaam se."_

- `ask()` returns the model's output.
- A new `classifyWork` stage sends every step and requires back, per position, **an `aiWork` part
  and a `humanWork` part** — either may be null and **both may be present**. A step that divides
  produces two nodes, each labelled with its own half in the model's words, and the chain threads
  through both. The person's half is what reaches their to-do.
- `Human` is no longer offered on the form or in the Excel template. It is still stored, still
  read, and still accepted on upload — objectives written before this carry it, and refusing them
  would be this release's decision applied to their data.
- A new step defaults to `Engine` rather than to a value the picker no longer has.

**When the model cannot answer, the run fails and builds nothing.** The client's decision, taken
against two alternatives: falling back on the grid column would quietly reinstate the behaviour
this replaces under a screen claiming the AI had decided, and calling everything human hands a
company a 25-step objective their team now owns because a provider was down.

This is _after_ the gateway's own fallback — `OBJECTIVE_PLANNER` tries OpenAI and then Anthropic,
so a provider being down is not what this catches. It catches an answer that came back and was not
a classification. A partial answer fails too, naming the positions left out: six unclassified steps
would otherwise become AI work silently, and the objective approved would not be the objective
written.

**Still open, and recorded rather than quietly left:** six of the seven stages still discard their
answers. Only the classification consumes its reply today. The tool list, the Skill match and the
owner assignment each ask a model something that has no validated field to land in, and inventing
one from an unchecked reply is how a plan ends up citing tools a company does not have.

**Verified:** 41 analysis tests including three new ones — a step that divides into both kinds, an
unusable answer, and a partial answer — plus 86 objective versioning and closure tests, 16 workbook
tests, 1163 type tests, 160 web and 299 UI.

---

## 13. The analysis screen drew its own cramped copy of a workflow an editor already handled

**Doing this:** press **Run Objective** and wait for the seven stages.

**What happened, in three separate faults:**

**A list of seven names was the whole progress report.** `3 of 7` in small grey text beside seven
rows that slowly changed colour. The comment beside it argued a percentage would be invented
because "the run reports stages and not fractions" — true of _time_, since stage five is not five
sevenths of the wait, and not true of _progress_. Three stages of seven finished is three sevenths
of the work, and it is the number somebody glancing at a long job actually wants.

**Fixed.** A `ProgressRing` holds the figure in the middle of its own arc, with the counts under it
so nobody has to trust the rounding. The arc grows on `--uboss-motion-signature`, the token whose
comment already names this gesture; a halo turns on `--uboss-motion-ambient-ring` **only while a
run is genuinely in flight** — a run cancelled at stage three is also three of seven, and a ring
still turning would say work is happening when none is.

Three things were wrong with the ring on first sight and were fixed by looking at it rather than at
the code: it was 132px against a 220px list basis in a 346px panel, so the list wrapped underneath
and left the ring stranded; the caption inherited the panel's capitals and read `2 OF 7`; and the
track was heavier than the number it annotates.

**The finished plan was drawn here, read-only, at a fixed size.** No zoom, no way to add a step —
beside a full editor that has both, reachable only by a small button underneath. So the screen
somebody lands on after a seven-stage run was the one they could do least with.

**Fixed.** The run finishing opens the editor. Only on the transition: a run that finished last
week still shows this screen, because the summary, the usage estimate and the gaps live here.

**The plan had no zoom.** A twenty-five step objective could be read a node at a time or not at
all. **Fixed** — out to half size, in to double, the figure itself resets to 100%.

---

## 14. Text left its own shape, and a label said the opposite of the plan beside it

**Doing this:** open the workflow editor and look at a diamond.

**What happened:** every node drew its three lines at `x=14`, left-aligned, whatever shape it was.
A 196×68 rectangle has room at x=14. A **diamond** of the same bounds has corners at (98,0),
(196,34), (98,68) and (0,34) — so on the kind line, at y=20, the shape only spans x≈40 to x≈156.
The text began 26px outside its own node and ran past the far edge, across the connector beneath.

It had been wrong since the canvas was written, and it became obvious only now: the labels used to
be short grid entries and are now the model's own sentences.

**Fixed** from the geometry, not from taste. A diamond is `196 × (1 − dy/34)` wide at height `dy`
from its centre, so its three lines have about 115px, 161px and 69px; the hexagonal gate loses 14px
at each end. Those divide by the three type sizes into the character limits now applied per shape,
and the two shapes that narrow centre their text — a left inset on a diamond would have to be the
inset of its _narrowest_ line, which wastes the width the middle line has.

**And the source panel contradicted the plan.** It read `whoEngine === 'Human' ? 'Human' : 'AI'`,
so once `Human` stopped being selectable every source step printed **AI** — in a list beside a
diagram showing human nodes, on the same screen. It now names the layer the step was written
against, which is what that column still means.

**Verified** in a browser: no node's text leaves its box, the ring moves 14 → 29 → 43 → 57 → 71 →
86, the editor opens by itself when the run completes, zooming out really redraws the plan smaller,
and the per-node add control still works.

---

## 15. The template's stars, revisited — and a column for the photograph

**The client's instruction**, after using the file: take the star off Email, and give the
photograph a column of its own so it is obvious where the picture goes.

**Email is no longer required**, and the change had to reach further than the template. It was
required from CR-04 in three places: the template's star, `BulkOperationService.validateRow`, and
`EmploymentService.addEmployee`. Relaxing only the first two would have produced a row that
previewed **Valid** and failed at apply — the precise failure the preview exists to prevent.

So the rule moved in `addEmployee`, which is deliberately the single door every path goes through,
including bulk. A flag letting an import skip a rule the form still enforced would have been
exactly the way around the gates that the bulk design exists to prevent.

What is left is the rule that mattered: **a company must be able to reach an employee**, and Phone
still carries it. The Add Employee form still asks for an email and will not submit without one —
its asterisk means "this screen needs it", which is true, and a person filling a form has the
person in front of them.

A blank must not be caught by the next check either: `!workEmail.includes('@')` refuses an empty
string as cheerfully as a malformed one, so the shape check is now guarded. The rule removed on one
line and kept on the next is a real way to ship nothing at all.

**Reporting Manager keeps its star, but only where it is true.** The client asked for that one too.
It could not simply go: `addEmployee` refuses a second person with nobody above them, because a
chart with two disconnected roots has no top. Removing the star would have made the file promise
what the import then refuses — the bug class this document records three times already.

The template is generated per company at download time, so it can answer honestly: **no star for a
company with nobody in it** (whose first employee _must_ leave it blank), a star once somebody is
at the top. The lie is removed exactly where it was one.

**The photograph now has a column.** The picture was always matched to a person by the row it sits
on, never by a cell, so the feature needed nothing — but it lived first on a sheet of its own and
then on the Employee Name heading as a comment, and in both places it had to be gone looking for.
A column says where to put the thing at the moment somebody is looking at the row.

**Verified in the client's own Chrome, signed in as themselves:** the template downloads with
`Email` and `Photo` unstarred; a row filled from the dropdowns with **no email** and a picture
pasted into the Photo column previews `1 ready and 0 refused`, applies as `1 added`, and the person
arrives with `workEmail: null`, their specialization and their manager. The photograph is in
`employee_photos`, its `files` row says `import-photo.png / image/png`, and the bytes on disk are a
real PNG — 122 of them, starting `89 50 4E 47`.

11 workbook tests, 77 users-and-access, 309 UI, 160 web.
