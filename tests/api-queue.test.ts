import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Api } from 'grammy';
import { ApiQueue, withModerationPriority } from '../src/bot/apiQueue.ts';

interface Call {
  method: string;
  payload: Record<string, unknown>;
  at: number;
}

function fixture(response?: (call: Call) => object) {
  const calls: Call[] = [];
  const queue = new ApiQueue();
  const api = new Api('test-token', {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const call = {
        method: String(url).split('/').at(-1) ?? '',
        payload: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        at: Date.now(),
      };
      calls.push(call);
      return new Response(
        JSON.stringify(response?.(call) ?? { ok: true, result: { message_id: 1 } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  api.config.use(queue.transformer);
  return { queue, api, calls };
}

test('moderation bypasses send cooldown; its reply overtakes waiting entertainment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  try {
    await f.api.sendSticker(-100, 'first');
    const normal = f.api.sendSticker(-100, 'waiting');
    const urgent = withModerationPriority(async () => {
      await f.api.banChatMember(-100, 7);
      await f.api.sendMessage(-100, 'banned');
    });
    t.mock.timers.tick(40);
    await setImmediate();
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ['sendSticker', 'banChatMember'],
    );
    t.mock.timers.tick(3060);
    await setImmediate();
    await urgent;
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ['sendSticker', 'banChatMember', 'sendMessage'],
    );
    t.mock.timers.tick(3100);
    await normal;
    assert.equal(f.calls[3]?.payload.sticker, 'waiting');
  } finally {
    f.queue.close();
  }
});

test('429 retries the same request after retry_after, giving waiting moderation priority', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let attempts = 0;
  const f = fixture((call) => {
    if (call.method === 'sendSticker' && attempts++ === 0)
      return {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 2 },
      };
    return { ok: true, result: true };
  });
  try {
    const sticker = f.api.sendSticker(-100, 'retry-me');
    await setImmediate();
    const ban = withModerationPriority(() => f.api.banChatMember(-100, 7));
    t.mock.timers.tick(2099);
    await setImmediate();
    assert.equal(f.calls.length, 1);
    t.mock.timers.tick(1);
    await ban;
    assert.equal(f.calls[1]?.method, 'banChatMember');
    t.mock.timers.tick(1000);
    await sticker;
    assert.equal(f.calls[2]?.payload.sticker, 'retry-me');
    assert.equal(attempts, 2);
  } finally {
    f.queue.close();
  }
});

test('other chats and polling do not wait for a busy chat cooldown; edits are paced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  try {
    await f.api.sendMessage(-100, 'first');
    const edit = f.api.editMessageText(-100, 1, 'frame');
    const other = f.api.sendMessage(-200, 'other');
    await f.api.getUpdates();
    t.mock.timers.tick(40);
    await other;
    assert.equal(f.calls[2]?.payload.chat_id, -200);
    assert.equal(f.calls.length, 3);
    t.mock.timers.tick(3060);
    await edit;
    assert.equal(f.calls[3]?.method, 'editMessageText');
    assert.equal(f.calls[3]?.at, 3100);
  } finally {
    f.queue.close();
  }
});

test('failed requests do not poison the queue and shutdown cancels pending calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture((call) =>
    call.payload.text === 'bad'
      ? { ok: false, error_code: 400, description: 'Bad Request' }
      : { ok: true, result: true },
  );
  try {
    await assert.rejects(f.api.sendMessage(-100, 'bad'), /Bad Request/);
    const good = f.api.sendMessage(-100, 'good');
    t.mock.timers.tick(3100);
    await good;
    const pending = f.api.sendMessage(-100, 'pending');
    const rejected = assert.rejects(pending, /aborted/);
    f.queue.close();
    await rejected;
    t.mock.timers.tick(10_000);
    assert.equal(f.calls.length, 2);
  } finally {
    f.queue.close();
  }
});
