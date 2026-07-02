import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Message } from 'grammy/types';
import { parseAction } from '../src/parser/index.ts';

function message(text: string, extra: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -100, type: 'supergroup', title: 'chat' },
    from: { id: 5, is_bot: false, first_name: 'Sender', username: 'sender' },
    text,
    ...extra,
  } as unknown as Message;
}

const reply = {
  reply_to_message: {
    message_id: 42,
    date: 0,
    chat: { id: -100, type: 'supergroup', title: 'chat' },
    from: { id: 99, is_bot: false, first_name: 'Victim', username: 'victimuser' },
    text: 'что-то написал',
  },
} as unknown as Partial<Message>;

describe('slash commands', () => {
  test('read-only commands', () => {
    assert.equal(parseAction(message('/stats')).type, 'stats');
    assert.equal(parseAction(message('/top')).type, 'top');
    assert.equal(parseAction(message('/pool')).type, 'pool');
    assert.equal(parseAction(message('/arm_help')).type, 'help');
    assert.equal(parseAction(message('/lef_top')).type, 'lef_top');
    assert.equal(parseAction(message('/snake_top')).type, 'lef_top');
  });

  test('add sticker pack / gif with pools', () => {
    assert.deepEqual(parseAction(message('/addstickerpack My_Pack_by_bot')), {
      type: 'add_sticker_pack',
      packName: 'My_Pack_by_bot',
      pool: 'regular',
    });
    assert.deepEqual(parseAction(message('/addultrastickerpack Ultra_by_bot')), {
      type: 'add_sticker_pack',
      packName: 'Ultra_by_bot',
      pool: 'ultra',
    });
    assert.deepEqual(parseAction(message('/addgif')), { type: 'add_gif', pool: 'regular' });
    assert.deepEqual(parseAction(message('/addultragif')), { type: 'add_gif', pool: 'ultra' });
  });

  test('retag argument quirks', () => {
    assert.deepEqual(parseAction(message('/retag all 30')), {
      type: 'retag',
      pool: 'all',
      limit: 30,
    });
    assert.deepEqual(parseAction(message('/retag regular')), {
      type: 'retag',
      pool: 'regular',
      limit: 25,
    });
    assert.deepEqual(parseAction(message('/retag 20')), { type: 'retag', pool: 'all', limit: 20 });
    assert.deepEqual(parseAction(message('/retag')), { type: 'retag', pool: 'all', limit: 25 });
    assert.deepEqual(parseAction(message('/retag ultra 999')), {
      type: 'retag',
      pool: 'ultra',
      limit: 100,
    });
  });

  test('mute via slash with duration units', () => {
    const m1 = parseAction(message('/mute 10', reply));
    assert.equal(m1.type, 'mute');
    if (m1.type === 'mute') {
      assert.equal(m1.minutes, 10);
    }

    const m2 = parseAction(message('/mute @victimuser 2 часа'));
    assert.equal(m2.type, 'mute');
    if (m2.type === 'mute') {
      assert.equal(m2.minutes, 120);
      assert.equal(m2.target?.username, 'victimuser');
    }

    const m3 = parseAction(message('/mute 1д', reply));
    assert.equal(m3.type, 'mute');
    if (m3.type === 'mute') {
      assert.equal(m3.minutes, 1440);
    }
  });

  test('ban via slash resolves reply target', () => {
    const ban = parseAction(message('/ban', reply));
    assert.equal(ban.type, 'ban');
    if (ban.type === 'ban') {
      assert.equal(ban.target?.userId, 99);
      assert.equal(ban.target?.messageId, 42);
    }
  });
});

describe('Арматурина phrases', () => {
  test('hit by mention', () => {
    const hit = parseAction(message('Арматурина, дай по хрептине @victimuser'));
    assert.equal(hit.type, 'hit');
    if (hit.type === 'hit') {
      assert.equal(hit.target.username, 'victimuser');
    }
  });

  test('hit by bare mention', () => {
    assert.equal(parseAction(message('Арматурина, @victimuser')).type, 'hit');
  });

  test('hit by fas on reply', () => {
    const hit = parseAction(message('Арматурина фас', reply));
    assert.equal(hit.type, 'hit');
    if (hit.type === 'hit') {
      assert.equal(hit.target.userId, 99);
    }
  });

  test('mute phrase with duration', () => {
    const mute = parseAction(message('Арматурина завари ебало на 10 минут', reply));
    assert.equal(mute.type, 'mute');
    if (mute.type === 'mute') {
      assert.equal(mute.minutes, 10);
    }
  });

  test('ban phrase', () => {
    assert.equal(parseAction(message('Арматурина уеби его', reply)).type, 'ban');
  });

  test('lef phrases pick the variant and target', () => {
    const self = parseAction(message('Арматурина оформи горловой'));
    assert.equal(self.type, 'lef');
    if (self.type === 'lef') {
      assert.equal(self.variant, 'горловой');
      assert.equal(self.target?.userId, 5);
    }

    const other = parseAction(message('Арматурина оформи слюнявый @victimuser'));
    assert.equal(other.type, 'lef');
    if (other.type === 'lef') {
      assert.equal(other.variant, 'слюнявый');
    }

    const blow = parseAction(message('Арматурина сделай минет'));
    assert.equal(blow.type, 'lef');
    if (blow.type === 'lef') {
      assert.equal(blow.variant, 'минет');
    }
  });

  test('add pack / gif phrases', () => {
    assert.deepEqual(parseAction(message('Арматурина, добавь стикерпак Cool_by_bot')), {
      type: 'add_sticker_pack',
      packName: 'Cool_by_bot',
      pool: 'regular',
    });
    assert.deepEqual(parseAction(message('Арматурина добавь ультра гифку', reply)), {
      type: 'add_gif',
      pool: 'ultra',
    });
  });

  test('a text_mention entity without a user falls back instead of crashing', () => {
    const extra = {
      ...reply,
      entities: [{ type: 'text_mention', offset: 0, length: 5 }],
    } as unknown as Partial<Message>;
    const hit = parseAction(message('Арматурина фас', extra));

    assert.equal(hit.type, 'hit');
    if (hit.type === 'hit') {
      assert.equal(hit.target.userId, 99);
    }
  });

  test('an unknown lef verb is swallowed, not a hit', () => {
    assert.equal(parseAction(message('Арматурина оформи непонятно')).type, 'none');
  });

  test('non-trigger and non-actionable chatter is none', () => {
    assert.equal(parseAction(message('привет всем')).type, 'none');
    assert.equal(parseAction(message('Арматурина как дела')).type, 'none');
  });
});
