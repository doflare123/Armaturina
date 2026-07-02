import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDuration, isoWeekKey, pluralizeRu } from '../src/util/time.ts';

describe('isoWeekKey', () => {
  test('numbers weeks ISO-8601 style, in UTC', () => {
    assert.equal(isoWeekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
    assert.equal(isoWeekKey(new Date('2026-01-05T00:00:00Z')), '2026-W02');
    // 2024-12-30 (Mon) belongs to ISO week 2025-W01.
    assert.equal(isoWeekKey(new Date('2024-12-30T12:00:00Z')), '2025-W01');
  });
});

describe('pluralizeRu', () => {
  const forms: [string, string, string] = ['минуту', 'минуты', 'минут'];

  test('picks the right grammatical form', () => {
    assert.equal(pluralizeRu(1, forms), 'минуту');
    assert.equal(pluralizeRu(2, forms), 'минуты');
    assert.equal(pluralizeRu(5, forms), 'минут');
    assert.equal(pluralizeRu(11, forms), 'минут');
    assert.equal(pluralizeRu(21, forms), 'минуту');
    assert.equal(pluralizeRu(22, forms), 'минуты');
  });
});

describe('formatDuration', () => {
  test('renders minutes', () => {
    assert.equal(formatDuration(1), '1 минуту');
    assert.equal(formatDuration(10), '10 минут');
    assert.equal(formatDuration(21), '21 минуту');
  });

  test('renders whole hours and days', () => {
    assert.equal(formatDuration(60), '1 час');
    assert.equal(formatDuration(120), '2 часа');
    assert.equal(formatDuration(1440), '1 день');
    assert.equal(formatDuration(2880), '2 дня');
    assert.equal(formatDuration(43200), '30 дней');
  });
});
