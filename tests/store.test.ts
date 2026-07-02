import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Sticker, User } from 'grammy/types';
import { type MediaPoolImport, MemoryStore } from '../src/store/memoryStore.ts';
import type { MediaMetadata, ResolvedTarget } from '../src/types.ts';

function sticker(id: string): Sticker {
  return {
    file_id: id,
    file_unique_id: id,
    type: 'regular',
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
  } as unknown as Sticker;
}

function meta(tags: string[]): MediaMetadata {
  return {
    tags,
    mood: null,
    caption: null,
    analysisFileId: null,
    analysisMimeType: null,
    taggedAt: null,
  };
}

function target(userId: number, username: string): ResolvedTarget {
  return { userId, username, label: `@${username}` };
}

function user(id: number, username: string): User {
  return { id, is_bot: false, first_name: 'U', username } as unknown as User;
}

describe('media pools', () => {
  test('add stickers and report pool stats', async () => {
    const store = new MemoryStore();
    await store.addStickerSet('set1', [sticker('a'), sticker('b')], 'regular', new Map());

    const stats = store.getStats();
    assert.equal(stats.stickerSets, 1);
    assert.equal(stats.stickers, 2);
    assert.equal(store.hasMedia('regular'), true);
    assert.equal(store.hasMedia('ultra'), false);
  });

  test('best-by-tags prefers the highest overlap', async () => {
    const store = new MemoryStore();
    await store.addStickerSet(
      'set',
      [sticker('a'), sticker('b')],
      'regular',
      new Map([
        ['a', meta(['злость', 'кринж'])],
        ['b', meta(['радость'])],
      ]),
    );

    assert.equal(store.getBestMediaByTags('regular', ['злость'])?.fileId, 'a');
    assert.equal(store.getBestMediaByTags('regular', ['радость'])?.fileId, 'b');
    assert.equal(store.getBestMediaByTags('regular', ['победа']), null);
  });

  test('untagged media respects the limit', async () => {
    const store = new MemoryStore();
    await store.addStickerSet(
      'set',
      [sticker('a'), sticker('b'), sticker('c')],
      'regular',
      new Map([['a', meta(['злость'])]]),
    );

    assert.deepEqual(
      store
        .getUntaggedMedia('regular', 10)
        .map((m) => m.fileId)
        .sort(),
      ['b', 'c'],
    );
    assert.equal(store.getUntaggedMedia('regular', 1).length, 1);
  });
});

describe('hit stats', () => {
  test('accumulates totals, ultras and weekly leader', async () => {
    const store = new MemoryStore();
    await store.recordHit(1, target(10, 'victim'), false);
    await store.recordHit(1, target(10, 'victim'), true);

    const stats = store.getChatStats(1);
    assert.equal(stats.totalHits, 2);
    assert.equal(stats.ultraHits, 1);
    assert.equal(stats.uniqueVictims, 1);
    assert.equal(stats.leader?.label, '@victim');

    const top = store.getWeeklyTop(1, 10);
    assert.equal(top[0]?.weeklyHits, 2);
    assert.equal(top[0]?.ultraHits, 1);
  });
});

describe('lef stats', () => {
  test('ranks snakes by total', async () => {
    const store = new MemoryStore();
    await store.recordLef(1, target(1, 's1'));
    await store.recordLef(1, target(2, 's2'));
    await store.recordLef(1, target(1, 's1'));

    const top = store.getLefTop(1, 10);
    assert.equal(top[0]?.label, '@s1');
    assert.equal(top[0]?.total, 2);
    assert.equal(top[1]?.total, 1);
  });
});

describe('moderation abuse', () => {
  test('counts within the window and resets after it', async () => {
    const store = new MemoryStore();
    const abuser = user(7, 'abuser');

    assert.equal((await store.recordModerationAbuse(1, abuser, 1_000)).count, 1);
    assert.equal((await store.recordModerationAbuse(1, abuser, 2_000)).count, 2);

    const afterWindow = 2_000 + 31 * 60 * 1_000;
    assert.equal((await store.recordModerationAbuse(1, abuser, afterWindow)).count, 1);
  });
});

describe('serialization round-trip', () => {
  test('export then import preserves media and stats', async () => {
    const store = new MemoryStore();
    await store.addStickerSet('set', [sticker('a')], 'regular', new Map([['a', meta(['злость'])]]));
    await store.addAnimation('gif1', 'ultra', meta(['мем']));
    await store.recordHit(1, target(10, 'victim'), true);
    await store.recordLef(1, target(3, 'snake'));

    const dump = store.exportMediaPool();
    const restored = new MemoryStore();
    restored.importMediaPool(dump);

    assert.deepEqual(restored.getStats(), store.getStats());
    assert.equal(restored.getChatStats(1).totalHits, 1);
    assert.equal(restored.getLefTop(1, 10)[0]?.label, '@snake');
    assert.equal(restored.getBestMediaByTags('regular', ['злость'])?.fileId, 'a');
    assert.deepEqual(restored.exportMediaPool(), dump);
  });

  test('tolerates a null moderationAbuse chat and normalises empty setName', () => {
    const store = new MemoryStore();
    const malformed = {
      stickerSets: ['s'],
      stickers: [{ fileId: 'a', setName: '' }],
      moderationAbuse: { '123': null },
    } as unknown as MediaPoolImport;

    // Must not throw on a hand-edited/corrupted file...
    store.importMediaPool(malformed);
    // ...and an empty setName is normalised to null, matching the original loader.
    assert.equal(store.exportMediaPool().stickers[0]?.setName, null);
  });
});
