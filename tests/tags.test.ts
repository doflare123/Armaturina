import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countTagMatches, normalizeTag, normalizeTags } from '../src/tags.ts';

describe('normalizeTag', () => {
  test('keeps catalog tags verbatim', () => {
    assert.equal(normalizeTag('злость'), 'злость');
  });

  test('maps english aliases onto the catalog', () => {
    assert.equal(normalizeTag('cringe'), 'кринж');
    assert.equal(normalizeTag('RAGE'), 'злость');
    assert.equal(normalizeTag('celebration'), 'праздник');
  });

  test('collapses whitespace to underscores', () => {
    assert.equal(normalizeTag('угроза шутка'), 'угроза_шутка');
  });

  test('keeps unknown tags but strips punctuation', () => {
    assert.equal(normalizeTag('  Wat?!  '), 'wat');
  });

  test('returns null for empty input', () => {
    assert.equal(normalizeTag('   '), null);
    assert.equal(normalizeTag(null), null);
  });
});

describe('normalizeTags', () => {
  test('dedupes and maps aliases', () => {
    assert.deepEqual(normalizeTags(['cringe', 'кринж', 'ЗЛОСТЬ']), ['кринж', 'злость']);
  });

  test('caps at eight tags', () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    assert.equal(normalizeTags(many).length, 8);
  });

  test('tolerates non-arrays', () => {
    assert.deepEqual(normalizeTags(undefined), []);
    assert.deepEqual(normalizeTags('nope'), []);
  });
});

describe('countTagMatches', () => {
  test('counts overlap after normalisation', () => {
    assert.equal(countTagMatches(['кринж', 'злость'], ['злость', 'радость']), 1);
    assert.equal(countTagMatches(['angry'], ['злость']), 1);
    assert.equal(countTagMatches(['радость'], ['злость']), 0);
  });
});
