import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIONS } from './authorization.js';
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONES,
  CONNECTION_STATES,
  CONNECTOR_DEFINITIONS,
  connectorDefinition,
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  derivedConnectionState,
  HIGH_RISK_TOOL_CATEGORIES,
  isCredentialExpiringSoon,
  isHighRiskToolCategory,
  TOOL_ACTION_CATEGORIES,
  TOOL_CATEGORY_DESCRIPTIONS,
  TOOL_CATEGORY_LABELS,
  USABLE_CONNECTION_STATES,
} from './connections.js';

/*
 * The first test in this file is the one that matters most in the whole package.
 *
 * The client's rule is that a human's app permission and an Engine Agent's tool permission are
 * separate. Merging the two vocabularies is the single most dangerous shortcut available in this
 * codebase — a person granted `Administer` on Integrations would silently gain the ability to make
 * an agent delete records in a connected ERP, because one lookup would satisfy both. This asserts
 * the two lists cannot overlap, so a future edit that reaches for the convenient answer fails
 * here rather than in production.
 */
test('the agent tool vocabulary and the human action vocabulary share no member', () => {
  const humanActions = new Set<string>(ACTIONS);
  for (const category of TOOL_ACTION_CATEGORIES) {
    assert.equal(
      humanActions.has(category),
      false,
      `${category} appears in both vocabularies; they must stay separate`,
    );
  }

  const toolCategories = new Set<string>(TOOL_ACTION_CATEGORIES);
  for (const action of ACTIONS) {
    assert.equal(toolCategories.has(action), false, `${action} appears in both vocabularies`);
  }
});

test('the client’s four high-risk categories are marked, plus Delete', () => {
  assert.deepEqual([...HIGH_RISK_TOOL_CATEGORIES].sort(), [
    'Delete',
    'ExternalBulkSend',
    'FinancialChange',
    'ProductionChange',
    'SensitiveExport',
  ]);

  // Read and Write are the only two that are not high-risk. If a future category is added
  // without deciding its risk, this fails — which is the intended pressure.
  const notHighRisk = TOOL_ACTION_CATEGORIES.filter(
    (category) => !isHighRiskToolCategory(category),
  );
  assert.deepEqual([...notHighRisk], ['Read', 'Write']);
});

test('every tool category has a label and a description', () => {
  for (const category of TOOL_ACTION_CATEGORIES) {
    assert.ok(TOOL_CATEGORY_LABELS[category]?.length > 0, category);
    assert.ok(TOOL_CATEGORY_DESCRIPTIONS[category]?.length > 0, category);
  }
});

test('the five client states each have a label and a tone', () => {
  assert.equal(CONNECTION_STATES.length, 5);
  for (const state of CONNECTION_STATES) {
    assert.ok(CONNECTION_STATE_LABELS[state]?.length > 0, state);
    assert.ok(CONNECTION_STATE_TONES[state]?.length > 0, state);
  }

  // Only `Connected` is usable. A grant on any other state is permission that would fail.
  assert.deepEqual([...USABLE_CONNECTION_STATES], ['Connected']);
});

test('state derivation puts Disabled first and Expired before NeedsReauthorization', () => {
  const base = {
    disabledAt: null,
    credentialExpiresAt: null,
    needsReauthorization: false,
    lastError: null,
  };

  assert.equal(derivedConnectionState(base), 'Connected');

  // Disabled wins over everything: a disabled connection must not report Error and invite a fix.
  assert.equal(
    derivedConnectionState({
      disabledAt: new Date(),
      credentialExpiresAt: new Date(Date.now() - 1000),
      needsReauthorization: true,
      lastError: 'boom',
    }),
    'Disabled',
  );

  // Expired before NeedsReauthorization: re-consenting cannot fix a key that has run out, and
  // sending somebody to re-consent when they need a new key wastes their afternoon.
  assert.equal(
    derivedConnectionState({
      ...base,
      credentialExpiresAt: new Date(Date.now() - 1000),
      needsReauthorization: true,
      lastError: 'boom',
    }),
    'Expired',
  );

  // Error last: a transient failure on a valid credential is the least of these.
  assert.equal(
    derivedConnectionState({ ...base, needsReauthorization: true, lastError: 'boom' }),
    'NeedsReauthorization',
  );
  assert.equal(derivedConnectionState({ ...base, lastError: 'boom' }), 'Error');

  // Whitespace is not an error message.
  assert.equal(derivedConnectionState({ ...base, lastError: '   ' }), 'Connected');
});

test('an expiry exactly now is expired, not expiring', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(
    derivedConnectionState({
      disabledAt: null,
      credentialExpiresAt: now,
      needsReauthorization: false,
      lastError: null,
      now,
    }),
    'Expired',
  );
});

test('the expiry warning is a horizon, not a moment', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const within = new Date(now.getTime() + (CREDENTIAL_EXPIRY_WARNING_DAYS - 1) * 86_400_000);
  const beyond = new Date(now.getTime() + (CREDENTIAL_EXPIRY_WARNING_DAYS + 1) * 86_400_000);
  const past = new Date(now.getTime() - 1000);

  assert.equal(isCredentialExpiringSoon(within, now), true);
  assert.equal(isCredentialExpiringSoon(beyond, now), false);
  // Already gone is a different piece of news, and the sweep sends a different notification.
  assert.equal(isCredentialExpiringSoon(past, now), false);
  assert.equal(isCredentialExpiringSoon(null, now), false);
});

test('the catalogue only lists connectors with an adapter behind them', () => {
  // The pack: build a mock adapter, do not integrate every vendor. A catalogue entry with nothing
  // to talk to would fail in a way that looks like a credential problem.
  assert.ok(CONNECTOR_DEFINITIONS.length > 0);
  for (const definition of CONNECTOR_DEFINITIONS) {
    assert.equal(definition.isMock, true, `${definition.kind} claims a real integration`);
    assert.ok(definition.scopes.length > 0, definition.kind);
    assert.ok(definition.supportedCategories.length > 0, definition.kind);
    // A connector must not claim a category the vocabulary does not have.
    for (const category of definition.supportedCategories) {
      assert.ok(
        (TOOL_ACTION_CATEGORIES as readonly string[]).includes(category),
        `${definition.kind} claims unknown category ${category}`,
      );
    }
  }
});

test('a personal connector is never offered as company infrastructure', () => {
  const mailbox = connectorDefinition('mock-mailbox');
  assert.deepEqual([...(mailbox?.scopes ?? [])], ['User']);

  const erp = connectorDefinition('mock-erp');
  assert.deepEqual([...(erp?.scopes ?? [])], ['Company']);

  assert.equal(connectorDefinition('salesforce'), undefined);
});
