import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLead, validateLead } from '../src/lead/normalize.js';

test('maps differently named fields to one shape', () => {
  const lead = normalizeLead({ 'First Name': ' Ana ', Surname: 'Silva', 'Work Email': 'ANA@X.COM', Organization: 'X', 'Deal Size': '$9k' });
  assert.equal(lead.firstName, 'Ana');
  assert.equal(lead.lastName, 'Silva');
  assert.equal(lead.email, 'ana@x.com');
  assert.equal(lead.company, 'X');
  assert.equal(lead.budgetRaw, '$9k');
});

test('splits a full name', () => {
  const lead = normalizeLead({ name: 'Mary Jane Watson', email: 'm@x.com' });
  assert.equal(lead.firstName, 'Mary Jane');
  assert.equal(lead.lastName, 'Watson');
});

test('generates a stable id when none is given', () => {
  const a = normalizeLead({ email: 'a@b.com', company: 'B' });
  const b = normalizeLead({ email: 'a@b.com', company: 'B' });
  assert.match(a.id, /^lead_[0-9a-f]{12}$/);
  assert.equal(a.id, b.id);
});

test('validation catches bad email and missing identity', () => {
  assert.deepEqual(validateLead(normalizeLead({ email: 'nope', company: 'X' })).valid, false);
  assert.deepEqual(validateLead(normalizeLead({ email: 'a@b.com' })).errors, ['missing name and company']);
  assert.equal(validateLead(normalizeLead({ email: 'a@b.com', company: 'X' })).valid, true);
});
