import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import type { Transformer } from 'grammy';

const priority = new AsyncLocalStorage<number>();

/** Scope all API calls made by a moderation handler, including its replies. */
export function withModerationPriority<T>(task: () => T): T {
  return priority.run(1, task);
}

interface Request {
  chatId: string | undefined;
  paced: boolean;
  priority: number;
  run(): Promise<void>;
  cancel(): void;
}

/** Shared by every API user: handlers, animations, anti-spam and cleanup. */
export class ApiQueue {
  private readonly pending: Request[] = [];
  private readonly chatNext = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private globalNext = 0;
  private retryUntil = 0;

  constructor() {
    // One cancellation listener per queued request is intentional.
    setMaxListeners(0, this.abort.signal);
  }

  readonly transformer: Transformer = (prev, method, payload, signal) => {
    // Long polling has its own connection and must not occupy a queue slot.
    if (method === 'getUpdates') return prev(method, payload, signal);
    const chatId = 'chat_id' in payload ? String(payload.chat_id) : undefined;
    const paced = /^(send|editMessage|copyMessage|forwardMessage)/.test(method);
    const requestPriority = priority.getStore() ?? 0;
    // grammY also accepts a polyfilled signal, so bridge via events instead of
    // AbortSignal.any (which only accepts native signals in Node).
    const controller = new AbortController();
    const combinedSignal = controller.signal;
    const forwardAbort = () => controller.abort(new Error('Telegram API request aborted'));
    if (signal?.aborted || this.abort.signal.aborted) forwardAbort();
    else {
      signal?.addEventListener('abort', forwardAbort, { once: true });
      this.abort.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    return new Promise((resolve, reject) => {
      const finish = () => {
        combinedSignal.removeEventListener('abort', cancel);
        signal?.removeEventListener('abort', forwardAbort);
        this.abort.signal.removeEventListener('abort', forwardAbort);
      };
      const cancel = () => {
        const index = this.pending.indexOf(request);
        if (index !== -1) this.pending.splice(index, 1);
        finish();
        reject(combinedSignal.reason);
        this.pump();
      };
      const request: Request = {
        chatId,
        paced,
        priority: requestPriority,
        cancel,
        run: async () => {
          try {
            const response = await prev(
              method,
              payload,
              // grammY types use the polyfill; the client accepts native signals too.
              combinedSignal as unknown as NonNullable<Parameters<Transformer>[3]>,
            );
            combinedSignal.throwIfAborted();
            if (!response.ok && response.error_code === 429) {
              const seconds = response.parameters?.retry_after;
              if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
                // Telegram may freeze the whole bot. Requeue the same request,
                // allowing moderation to overtake it after the mandatory wait.
                this.retryUntil = Math.max(this.retryUntil, Date.now() + (seconds + 0.1) * 1000);
                this.pending.unshift(request);
                return;
              }
            }
            finish();
            resolve(response);
          } catch (error) {
            finish();
            reject(error);
          }
        },
      };
      if (combinedSignal.aborted) {
        cancel();
        return;
      }
      combinedSignal.addEventListener('abort', cancel, { once: true });
      this.pending.push(request);
      this.pump();
    });
  };

  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.abort.signal.aborted || !this.pending.length) return;
    const now = Date.now();
    let selected: Request | undefined;
    let next = Number.POSITIVE_INFINITY;
    for (const request of this.pending) {
      if (request.chatId !== undefined && this.busy.has(request.chatId)) continue;
      const ready = Math.max(
        this.globalNext,
        this.retryUntil,
        request.paced && request.chatId !== undefined
          ? (this.chatNext.get(request.chatId) ?? 0)
          : 0,
      );
      next = Math.min(next, ready);
      if (ready <= now && (!selected || request.priority > selected.priority)) selected = request;
    }
    if (!selected) {
      if (Number.isFinite(next))
        this.timer = setTimeout(() => this.pump(), Math.max(1, next - now));
      return;
    }
    this.pending.splice(this.pending.indexOf(selected), 1);
    const { chatId, paced } = selected;
    this.globalNext = now + 40;
    if (chatId !== undefined) {
      this.busy.add(chatId);
      if (paced) {
        // Conservatively count animation edits too: <=20 calls/minute/group.
        const interval = Number(chatId) < 0 ? 3100 : 1100;
        const deadline = now + interval;
        this.chatNext.set(chatId, deadline);
        setTimeout(() => {
          if (this.chatNext.get(chatId) === deadline) this.chatNext.delete(chatId);
        }, interval).unref?.();
      }
    }
    void selected.run().finally(() => {
      if (chatId !== undefined) this.busy.delete(chatId);
      this.pump();
    });
    this.pump();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort(new Error('Telegram API queue stopped'));
    for (const request of [...this.pending]) request.cancel();
    this.chatNext.clear();
  }
}
