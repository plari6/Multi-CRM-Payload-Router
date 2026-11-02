import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget } from '../src/lead/budget.js';

const usd = (raw, currency) => parseBudget(raw, currency)?.amountUsd ?? null;

test('plain and formatted numbers', () => {
  assert.equal(usd('25000'), 25000);
  assert.equal(usd('$45,000'), 45000);
  assert.equal(usd('USD 30000'), 30000);
});

test('k / M suffixes', () => {
  assert.equal(usd('25k'), 25000);
  assert.equal(usd('1.2M'), 1200000);
});

test('ranges use the midpoint', () => {
  assert.equal(usd('10k-20k'), 15000);
  assert.equal(usd('10-20k'), 15000);
  assert.equal(usd('between 8,000 and 14,000'), 11000);
});

test('currency conversion from symbol, code, or currency column', () => {
  assert.equal(usd('€10,000'), 10800);
  assert.equal(usd('2500', 'GBP'), 3175);
  assert.equal(usd('AED 30,000'), 8100);
});

test('text it cannot read returns null (so AI can try)', () => {
  assert.equal(usd('mid five figures'), null);
  assert.equal(usd('not sure yet'), null);
  assert.equal(usd(''), null);
  assert.equal(usd('Q3 2026, around 20k, call 555 0100'), null);
});
