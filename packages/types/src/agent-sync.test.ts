import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agentSyncIsCreatable,
  emptyAgentSyncEnvelope,
  missingAgentSyncFields,
  parseAgentMarkdown,
} from './agent-sync.js';

/**
 * Reading an agent that was built somewhere else.
 *
 * The cases here are the ones a real file actually presents: UBoss's own export, a Claude
 * subagent (front-matter plus a prompt, no Steps heading), and a file that says almost nothing.
 * The last is the one worth most — a parser that quietly invents a schedule is worse than one
 * that admits the file was thin.
 */
describe('reading an agent file', () => {
  const uboss = [
    '---',
    'name: Invoice checker',
    'purpose: Check vendor invoices against the PO and flag mismatches',
    'trigger: Daily at 9am',
    'runs_in: SAP',
    'output_to: Finance shared drive',
    'if_data_missing: Stop',
    'tools: SAP, Email',
    '---',
    '',
    '## Steps',
    "1. Pull yesterday's invoices — read them from the SAP inbox",
    '2. Match each against its purchase order',
    '3. Flag every mismatch over 50,000',
    '',
  ].join('\n');

  it('reads every field UBoss writes', () => {
    const read = parseAgentMarkdown(uboss);

    assert.equal(read.name, 'Invoice checker');
    assert.equal(read.purpose, 'Check vendor invoices against the PO and flag mismatches');
    assert.equal(read.runType, 'Scheduled');
    assert.equal(read.triggerOrFrequency, 'Daily at 9am');
    assert.equal(read.whereWorkHappens, 'SAP');
    assert.equal(read.outputDestination, 'Finance shared drive');
    assert.equal(read.missingDataBehaviour, 'Stop');
    assert.deepEqual(read.tools, ['SAP', 'Email']);
    assert.deepEqual(read.notFound, [], 'a complete file left something unread');
  });

  it('keeps the instruction beside the step rather than inside it', () => {
    // "Do the thing — how" is one step with its method, and a reviewer reading a list of actions
    // should not have to read a paragraph in the action column to find the action.
    const [first, second] = parseAgentMarkdown(uboss).steps;

    assert.equal(first?.what, "Pull yesterday's invoices");
    assert.equal(first?.how, 'read them from the SAP inbox');
    assert.equal(second?.what, 'Match each against its purchase order');
    assert.equal(second?.how, null, 'a step with no method should not invent one');
  });

  it('reads a Claude subagent, which is the one foreign export already in Markdown', () => {
    const claude = [
      '---',
      'name: release-notes-writer',
      'description: Turns merged pull requests into release notes',
      'tools: [Read, Grep]',
      '---',
      '',
      'You write release notes. Work through them in order:',
      '',
      '1. Read every merged PR since the last tag',
      '2. Group them by area',
      '3. Write one line per change: plain words, no ticket numbers',
      '',
    ].join('\n');

    const read = parseAgentMarkdown(claude);
    assert.equal(read.name, 'release-notes-writer');
    assert.equal(read.purpose, 'Turns merged pull requests into release notes');
    assert.deepEqual(read.tools, ['Read', 'Grep']);
    // No "## Steps" heading anywhere: a numbered list in an agent's instructions is its
    // procedure whether or not somebody labelled it one.
    assert.equal(read.steps.length, 3);
    assert.equal(read.steps[0]?.what, 'Read every merged PR since the last tag');
  });

  it('infers a schedule from a trigger, and nothing from silence', () => {
    const scheduled = parseAgentMarkdown('---\nname: A\npurpose: B\ntrigger: every Monday\n---\n');
    assert.equal(scheduled.runType, 'Scheduled', 'every Monday is a schedule');

    const evented = parseAgentMarkdown(
      '---\nname: A\npurpose: B\ntrigger: when a tender is published\n---\n',
    );
    assert.equal(evented.runType, 'EventBased');

    const silent = parseAgentMarkdown('---\nname: A\npurpose: B\n---\n');
    assert.equal(silent.runType, null, 'a file that said nothing was answered for');
  });

  it('names what the file did not contain, rather than leaving it silent', () => {
    /*
     * The failure this prevents: a person confirming an import has to tell "the file said
     * nothing about this" from "the file said it and it was read wrong". Both look like an empty
     * box, and they are fixed differently — one by typing, one by fixing the parser.
     */
    const thin = parseAgentMarkdown('---\nname: Just a name\n---\n');

    assert.deepEqual(thin.notFound, [
      'purpose',
      'runType',
      'triggerOrFrequency',
      'whereWorkHappens',
      'outputDestination',
      'missingDataBehaviour',
      'steps',
      'tools',
    ]);
  });

  it('reads a file with no front-matter at all without throwing', () => {
    // Somebody will drop a plain prompt. It should come back almost empty and perfectly calm,
    // because the model reader is what handles that case and it needs this one not to explode.
    const read = parseAgentMarkdown('You are a helpful assistant that files expenses.\n');

    assert.equal(read.name, '');
    assert.ok(read.notFound.includes('name'));
    assert.equal(agentSyncIsCreatable(read), false);
  });

  it('never invents a missing-data rule, because the company owns that choice', () => {
    const made = parseAgentMarkdown('---\nname: A\npurpose: B\nif_data_missing: whatever\n---\n');
    assert.equal(made.missingDataBehaviour, null);
    assert.ok(made.notFound.includes('missingDataBehaviour'));
  });

  it('accepts the words people actually write for the closed vocabularies', () => {
    const said = parseAgentMarkdown(
      '---\nname: A\npurpose: B\nrun_type: on demand\nif_data_missing: ask\n---\n',
    );
    assert.equal(said.runType, 'Manual');
    assert.equal(said.missingDataBehaviour, 'AskUser');
  });

  it('is creatable on a name and a purpose, and on nothing less', () => {
    // Everything else is a question the builder screen already knows how to ask. Refusing an
    // import for a missing schedule would send somebody back to edit a file when the field is
    // in front of them.
    const envelope = emptyAgentSyncEnvelope();
    assert.equal(agentSyncIsCreatable(envelope), false);

    envelope.name = 'Invoice checker';
    assert.equal(agentSyncIsCreatable(envelope), false);

    envelope.purpose = 'Check invoices';
    assert.equal(agentSyncIsCreatable(envelope), true);
    assert.ok(missingAgentSyncFields(envelope).length > 0, 'still incomplete, and still creatable');
  });

  it('treats whitespace as absence, so a file of empty keys is not a filled one', () => {
    const blank = parseAgentMarkdown('---\nname: "   "\npurpose: ""\n---\n');
    assert.equal(agentSyncIsCreatable(blank), false);
    assert.ok(blank.notFound.includes('name'));
  });

  it('reads a file written with Windows line endings', () => {
    // Every file in this feature arrives from somebody else's machine, and half of those are
    // Windows. A parser anchored on \n alone would read the whole front-matter as one key.
    const read = parseAgentMarkdown('---\r\nname: A\r\npurpose: B\r\n---\r\n\r\n1. Do it\r\n');
    assert.equal(read.name, 'A');
    assert.equal(read.purpose, 'B');
    assert.equal(read.steps[0]?.what, 'Do it');
  });
});
