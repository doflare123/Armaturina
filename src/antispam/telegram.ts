import type { Api } from 'grammy';
import type { CallbackQuery, Message } from 'grammy/types';
import { TechnicalCleanup } from '../bot/technicalCleanup.ts';
import type { SpamConfig } from './config.ts';
import { activeAction, decide } from './decision.ts';
import { calibrate, evaluationGroups, quality } from './governance.ts';
import { LearningService } from './learning.ts';
import type { SpamClassifier } from './model.ts';
import { ContextSignals, contextualScore } from './signals.ts';
import { SpamStore, type Verdict } from './store.ts';

function formatQuality(metrics: ReturnType<typeof quality>): string {
  const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
  return `TP/FP/TN/FN ${metrics.tp}/${metrics.fp}/${metrics.tn}/${metrics.fn}; precision ${pct(metrics.precision)}, recall ${pct(metrics.recall)}, F1 ${pct(metrics.f1)}, FPR ${pct(metrics.falsePositiveRate)}`;
}

/** Local inference, human feedback and explicitly approved ACTIVE message deletion. */
export class SpamTelegram {
  private readonly api: Api;
  private readonly config: SpamConfig;
  readonly store: SpamStore;
  readonly learning: LearningService;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly cleanup: TechnicalCleanup;
  private readonly signals = new WeakMap<SpamClassifier, ContextSignals>();

  constructor(api: Api, config: SpamConfig) {
    this.api = api;
    this.cleanup = new TechnicalCleanup(api);
    this.config = config;
    this.store = new SpamStore(config.databasePath);
    this.store.prune(config.retentionDays);
    this.learning = new LearningService(this.store);
    for (const chatId of config.chatIds) this.learning.current(chatId);
    this.timer = setInterval(() => {
      try {
        this.store.prune(config.retentionDays);
      } catch {
        console.error('antispam_maintenance_failed');
      }
    }, 60_000);
    this.timer.unref();
  }

  private enabled(message: Message): boolean {
    return (
      (message.chat.type === 'group' || message.chat.type === 'supergroup') &&
      this.config.chatIds.includes(message.chat.id)
    );
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await this.api.getChatMember(chatId, userId);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }

  async edited(message: Message, updateId?: number) {
    if (!this.enabled(message) || (message.from?.is_bot && !message.sender_chat)) return;
    const id = this.store.capture(message, updateId);
    if (id !== null && message.from && !message.from.is_bot && !message.sender_chat) {
      // An edit is content, never a command. Do not allow a slash prefix to bypass review.
      await this.suggest(message, id);
    }
  }

  async message(message: Message, botUsername: string, updateId?: number): Promise<boolean> {
    if (!this.enabled(message)) return false;
    this.store.observeJoins(message);
    const command = /^\/spam(?:@([a-z0-9_]+))?(?:\s+(.*))?$/iu.exec(message.text ?? '');
    if (!command) {
      if (!message.from?.is_bot || message.sender_chat) {
        const id = this.store.capture(message, updateId);
        if (
          id !== null &&
          message.from &&
          !message.from.is_bot &&
          !message.sender_chat &&
          !/^\//.test(message.text ?? '')
        )
          await this.suggest(message, id);
      }
      return false;
    }
    if (command[1] && command[1].toLowerCase() !== botUsername.toLowerCase()) return true;
    // Anonymous admins cannot provide attributable training labels.
    if (
      message.sender_chat ||
      !message.from ||
      !(await this.isAdmin(message.chat.id, message.from.id))
    ) {
      await this.reply(message, 'Разметка доступна администратору от личного аккаунта.');
      return true;
    }
    const input = command[2]?.trim() ?? 'status';
    const arg = input === 'rewiev' ? 'review' : input;
    if (arg.startsWith('active')) {
      try {
        const [, action, id, extra] = arg.split(/\s+/);
        if (action === 'log' && !id) {
          const entries = this.store.governance.active.log(message.chat.id);
          await this.reply(
            message,
            `${entries
              .map(
                (e) =>
                  `${e.prediction_id}: ${e.status} · ${new Date(e.created_at).toISOString()}\n${e.raw_text.slice(0, 150)}`,
              )
              .join('\n')}\nПроверить удаление: /spam active review <номер прогноза>`,
          );
          return true;
        }
        if (!id || extra)
          throw new Error(
            '/spam active prepare <version>\n/spam active sample <id>\n/spam active check <id>\n/spam active enable <id>',
          );
        const safety = this.store.governance.active;
        if (action === 'prepare') {
          const evaluationId = safety.prepare(message.chat.id, id, message.from.id);
          await this.reply(
            message,
            `Проверка ${evaluationId} начата в SHADOW. Собираются следующие 1000 уникальных пригодных прогнозов без отбора по score.\nРазметка: /spam active sample ${evaluationId}\nПроверка precision/FPR: /spam active check ${evaluationId}`,
          );
        } else if (action === 'check') {
          const result = safety.check(message.chat.id, id, message.from.id);
          await this.reply(
            message,
            `Допуск ${id}: ${result.passed ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}. Выборка ${result.samples}/1000, размечено ${result.labelled}.\n${formatQuality(result.metrics)}\nТребуется precision ≥99%, FPR ≤1%, ≥100 положительных прогнозов, ≥400 normal и все 1000 меток.\n${result.passed ? `Ручное включение удаления сообщений: /spam active enable ${id}` : 'ACTIVE отключён до успешной проверки.'}`,
          );
        } else if (action === 'enable') {
          if (!(await this.canDelete(message.chat.id)))
            throw new Error('Не удалось проверить право бота на удаление сообщений.');
          // Admin status is checked again after the additional Telegram request.
          if (!(await this.isAdmin(message.chat.id, message.from.id)))
            throw new Error('Права администратора не подтверждены.');
          safety.enable(message.chat.id, id, message.from.id);
          await this.reply(
            message,
            `ACTIVE включён на 7 дней: автоматическое удаление сообщений выше проверенного порога, не более одного в минуту. Банов и мутов нет. Отключить: /spam mode SHADOW`,
          );
        } else if (action === 'sample' || action === 'review') {
          const messageId =
            action === 'sample'
              ? safety.nextSample(message.chat.id, id)
              : safety.reviewMessage(message.chat.id, Number(id));
          if (messageId === null) {
            await this.reply(message, 'Нет новых неразмеченных примеров в этой проверке.');
            return true;
          }
          if (!this.store.isCurrent(messageId))
            throw new Error(
              'Пример отредактирован; прежнюю редакцию нельзя проверить этой карточкой. Начните новую проверку допуска.',
            );
          const item = this.store.createCase(messageId);
          if (item.card_id !== null || item.status !== 'PENDING')
            throw new Error(
              `Проверка уже существует: ${item.status}, ${item.id}. Завершите её; при истёкшей проверке начните новый допуск.`,
            );
          await this.sendCard(
            item,
            action === 'sample'
              ? 'Ручная разметка контрольной выборки (оценка модели скрыта)'
              : 'Проверка автоматического удаления. Normal отключит ACTIVE. Удалённое сообщение автоматически не восстановится.',
            message.message_id,
          );
        } else throw new Error('Команды допуска: prepare, sample, check, enable, log, review.');
      } catch (error) {
        await this.reply(message, error instanceof Error ? error.message : 'Допуск не изменён.');
      }
      return true;
    }
    if (/^(?:mode|models|rollback|threshold|metrics|calibrate)(?:\s|$)/.test(arg)) {
      try {
        const [command, value, extra] = arg.split(/\s+/);
        const current = this.learning.current(message.chat.id);
        const governance = this.store.governance;
        if (command === 'mode' && !extra && (value === 'SHADOW' || value === 'LEARNING')) {
          governance.setMode(message.chat.id, value, message.from.id);
          await this.reply(
            message,
            `Режим ${value}. ${value === 'SHADOW' ? 'Оценки сохраняются, новые автоматические карточки выключены. Ручная разметка доступна.' : 'Предложения администраторам включены.'} Автоматических наказаний нет.`,
          );
        } else if (command === 'models' && !value) {
          const versions = this.store.modelVersions(message.chat.id);
          await this.reply(
            message,
            versions
              .map(
                (v) =>
                  `${v.active ? 'АКТИВНА' : 'архив'} ${v.version}\n${new Date(v.trained_at).toISOString()} · порог ${v.threshold}`,
              )
              .join('\n') || 'Моделей пока нет.',
          );
        } else if (command === 'rollback' && value && !extra) {
          this.store.rollback(message.chat.id, value, message.from.id);
          this.learning.current(message.chat.id);
          await this.reply(
            message,
            `Активирована версия ${value} с её сохранённым порогом. Допуск ACTIVE отозван.`,
          );
        } else if (command === 'threshold' && value && extra && arg.split(/\s+/).length === 3) {
          governance.setThreshold(message.chat.id, value, Number(extra), message.from.id);
          await this.reply(
            message,
            `Для модели ${value} установлен порог ${Number(extra)}. Допуск ACTIVE отозван. Старые прогнозы не пересчитаны.`,
          );
        } else if ((command === 'metrics' || command === 'calibrate') && !extra) {
          const version = value ?? current?.version;
          if (!version) throw new Error('Выберите версию из /spam models.');
          // Full artifact lookup is scoped to this group, including archived versions.
          const model = this.store.modelArtifact(message.chat.id, version);
          const row = governance.policy(message.chat.id, version);
          const rows = governance.rows(message.chat.id, version, [
            ...model.trainHashes,
            ...model.validationHashes,
          ]);
          const groups = evaluationGroups(rows);
          if (command === 'calibrate') {
            const result = calibrate(rows);
            governance.audit(message.chat.id, message.from.id, 'calibration', {
              version,
              ...result,
              predictionIds: groups.map((r) => r.id),
            });
            await this.reply(
              message,
              `Модель ${version}. Проверяемый порог: ${result.threshold}.\nCalibration: ${result.calibrationSize}, ${formatQuality(result.calibration)}\nБолее поздний holdout: ${result.holdoutSize}, ${formatQuality(result.holdout)}\nЭто подбор порога на размеченной выборке, не калибровка вероятностей и не гарантия качества. Порог не изменён.\n${result.accepted ? `Проверка holdout пройдена. Применить: /spam threshold ${version} ${result.threshold}` : 'Holdout не подтвердил качество: применение не рекомендуется. Соберите новую разметку; другой порог по holdout не подбирается.'}`,
            );
          } else {
            const byMode = ['SHADOW', 'LEARNING', 'ACTIVE']
              .map(
                (mode) =>
                  `${mode}: ${rows.filter((r) => r.mode === mode).length} прогнозов; ${formatQuality(quality(evaluationGroups(rows.filter((r) => r.mode === mode)), row.threshold))}`,
              )
              .join('\n');
            const thresholds = [...new Set(rows.map((r) => r.threshold))].sort((a, b) => a - b);
            const historical = quality(
              groups.map((r) => ({ label: r.label, score: r.score >= r.threshold ? 1 : 0 })),
              0.5,
            );
            await this.reply(
              message,
              `Модель ${version}, контекстная политика 1, последние 30 дней (до 10000 прогнозов до фильтрации).\nНовых пригодных прогнозов: ${rows.length}; ${byMode}.\nРазмеченных уникальных групп: ${groups.length}. Неразмеченные не считаются normal.\nПересчёт при текущем пороге ${row.threshold}: ${formatQuality(quality(groups, row.threshold))}\nПо историческим порогам, до cooldown: ${formatQuality(historical)}\nИсторические пороги: ${thresholds.join(', ') || '—'}.\nЭто метрики выбранных для ручной проверки сообщений, не всего чата. Train/validation и противоречивые дубликаты исключены.`,
            );
          }
        } else
          throw new Error(
            '/spam mode SHADOW|LEARNING\n/spam models\n/spam rollback <version>\n/spam threshold <version> <0.05–1>\n/spam metrics [version]\n/spam calibrate [version]\n/spam active prepare <version>\n/spam active sample <id>\n/spam active check <id>\n/spam active enable <id>',
          );
      } catch (error) {
        await this.reply(
          message,
          error instanceof Error ? error.message : 'Операция не выполнена.',
        );
      }
      return true;
    }
    if (arg === 'train') {
      // Do not hold the per-chat update queue while CPU work runs in another thread.
      const task = this.learning.train(message.chat.id);
      void task
        .then(
          async (version) => {
            if (!this.closed)
              await this.reply(
                message,
                `Модель ${version} обучена. Режим ${this.store.governance.policy(message.chat.id, version).mode}; автоудаление отключено.`,
              );
          },
          async (error: Error) => {
            if (!this.closed) await this.reply(message, `Обучение не завершено: ${error.message}`);
          },
        )
        .catch(() => {
          console.error('antispam_training_notification_failed');
        });
      return true;
    }
    if (arg === 'status' || arg === 'stats') {
      const stats = this.store.stats(message.chat.id);
      const current = this.learning.current(message.chat.id);
      const metrics = current?.classifier.model.metrics;
      const policy = this.store.governance.policy(message.chat.id, current?.version ?? '');
      await this.reply(
        message,
        `Антиспам: ${policy.mode}, модель: ${current?.version ?? 'COLD_START'}. Порог: ${policy.threshold}. Автоудаление ${policy.mode === 'ACTIVE' ? 'включено по допуску администратора' : 'отключено'}.\nСообщений: ${stats?.messages}\nУникальных spam: ${stats?.spam}/50\nУникальных normal: ${stats?.normal}/200\nОжидают решения: ${stats?.pending}` +
          (metrics
            ? `\nValidation базовой модели, без контекстных сигналов, при пороге 0.60: precision ${(metrics.precision * 100).toFixed(1)}%, recall ${(metrics.recall * 100).toFixed(1)}%, F1 ${(metrics.f1 * 100).toFixed(1)}%, FPR ${(metrics.falsePositiveRate * 100).toFixed(1)}%\nЭти validation-метрики не являются допуском ACTIVE. Similarity, кампании и поведение входят в итоговую оценку.`
            : '\nДля первого обучения: /spam train') +
          (current
            ? `\nПризнаки: ${current.classifier.model.format === 3 ? 'char + word TF-IDF + числовые + Markov' : current.classifier.model.format === 2 ? 'char + word TF-IDF + числовые; Markov: /spam train' : 'только char TF-IDF; обновление: /spam train'}`
            : ''),
      );
      return true;
    }
    if (arg.startsWith('undo ')) {
      const id = arg.slice(5).trim();
      const item = this.store.getCase(id);
      const done = item?.chat_id === message.chat.id && this.store.undo(id, message.from.id);
      await this.reply(
        message,
        done
          ? 'Разметка отменена. Удалённое сообщение восстановить нельзя.'
          : 'Решение не найдено или уже отменено.',
      );
      return true;
    }
    if (arg !== 'review' || !message.reply_to_message) {
      await this.reply(
        message,
        '/spam review — ответом на сообщение для разметки.\n/spam train\n/spam status\n/spam stats\n/spam undo <id решения>\n/spam mode SHADOW|LEARNING\n/spam models\n/spam rollback <version>\n/spam threshold <version> <0.05–1>\n/spam metrics [version]\n/spam calibrate [version]\n/spam active prepare <version>\n/spam active sample <id>\n/spam active check <id>\n/spam active enable <id>',
      );
      return true;
    }
    const target = message.reply_to_message;
    if (target.chat.id !== message.chat.id || target.from?.is_bot || target.sender_chat) {
      await this.reply(message, 'Для проверки нужно сообщение пользователя этой группы.');
      return true;
    }
    if (target.date * 1000 < Date.now() - this.config.retentionDays * 86_400_000) {
      await this.reply(message, 'Сообщение старше срока хранения.');
      return true;
    }
    const id = this.store.capture(target, updateId);
    if (id === null) {
      await this.reply(
        message,
        'Нет текста/подписи или ответ содержит устаревшую версию. Ответьте заново на актуальное сообщение.',
      );
      return true;
    }
    const item = this.store.createCase(id);
    if (item.card_id !== null || item.status !== 'PENDING') {
      await this.reply(message, `Проверка уже существует: ${item.status}. ID: ${item.id}`);
      return true;
    }
    try {
      await this.sendCard(item, 'Ручная разметка', message.message_id);
    } catch (error) {
      this.cleanup.schedule(message.chat.id, message.message_id);
      throw error;
    }
    return true;
  }

  private async reply(message: Message, text: string) {
    try {
      const response = await this.api.sendMessage(message.chat.id, text);
      this.cleanup.schedule(message.chat.id, response?.message_id);
      return response;
    } finally {
      this.cleanup.schedule(message.chat.id, message.message_id);
    }
  }

  private async suggest(message: Message, messageId: number) {
    this.store.observe(message, messageId);
    if (this.store.hasPrediction(messageId)) return;
    const current = this.learning.current(message.chat.id);
    if (!current) return;
    const assessment = current.classifier.assess(
      message.text ?? message.caption ?? '',
      message.entities ?? message.caption_entities ?? [],
    );
    let protectedUser = true;
    try {
      const member = await this.api.getChatMember(message.chat.id, message.from?.id ?? 0);
      protectedUser = member.status === 'administrator' || member.status === 'creator';
    } catch {
      /* Unknown permissions suppress suggestions. */
    }
    // A worker or another connection may activate/rollback a model while Telegram is awaited.
    if (this.store.activeModel(message.chat.id)?.version !== current.version) return;
    let engine = this.signals.get(current.classifier);
    if (!engine) {
      engine = new ContextSignals(current.classifier);
      this.signals.set(current.classifier, engine);
    }
    const now = Date.now();
    const signals = engine.assess(
      message.text ?? message.caption ?? '',
      message.entities ?? message.caption_entities ?? [],
      message.from?.id ?? 0,
      now,
      this.store.signalContext(message.chat.id, message.from?.id ?? 0, message.message_id, now),
    );
    const score = contextualScore(assessment.finalScore, signals);
    const policy = this.store.governance.policy(message.chat.id, current.version);
    const result = decide(score, protectedUser, policy.threshold);
    if (result.decision === 'ASK_ADMIN' && (assessment.finalScore ?? 0) < policy.threshold)
      result.reason = 'context_above_review_threshold';
    const limited =
      policy.mode !== 'SHADOW' &&
      result.decision === 'ASK_ADMIN' &&
      !this.store.canPropose(message.chat.id);
    const predictionId = this.store.prediction(
      messageId,
      current.version,
      assessment.classifierScore,
      result.decision,
      limited ? 'review_rate_limited' : result.reason,
      assessment.markovScore,
      score,
      signals,
      policy,
    );
    if (predictionId === null) return;
    if (
      activeAction(score, protectedUser, policy.threshold, policy.mode === 'ACTIVE') === 'DELETE'
    ) {
      await this.deleteActive(message, messageId, predictionId, current.version);
      return;
    }
    if (policy.mode === 'SHADOW' || limited || result.decision !== 'ASK_ADMIN') return;
    const item = this.store.createCase(messageId, Date.now(), predictionId);
    if (item.card_id !== null || item.status !== 'PENDING') return;
    await this.sendCard(
      item,
      `Возможный спам — нужна проверка администратора.\nПриоритет проверки: ${((score ?? 0) * 100).toFixed(1)}/100 (не вероятность).\nКлассификатор: ${((assessment.classifierScore ?? 0) * 100).toFixed(1)}%\nMarkov: ${assessment.markovScore === null ? 'нет оценки' : `${(assessment.markovScore * 100).toFixed(1)}%`}\nSimilarity spam/normal: ${signals.spamSimilarity?.toFixed(2) ?? '—'}/${signals.normalSimilarity?.toFixed(2) ?? '—'}\nПохожих авторов за 10 мин: ${signals.campaignUsers}; сообщений автора за 60 с: ${signals.messagesLast60s}\nПоведение: ${signals.behaviorScore.toFixed(2)}; общих URL с другими авторами: ${signals.sameUrlOtherUsers}\nМодель: ${current.version}`,
    );
  }

  private async canDelete(chatId: number): Promise<boolean> {
    try {
      const me = await this.api.getMe();
      const member = await this.api.getChatMember(chatId, me.id);
      return (
        member.status === 'creator' ||
        (member.status === 'administrator' && member.can_delete_messages)
      );
    } catch {
      return false;
    }
  }

  private async deleteActive(
    message: Message,
    messageId: number,
    predictionId: number,
    version: string,
  ) {
    const safety = this.store.governance.active;
    const grant = safety.grant(message.chat.id, version);
    if (!grant || !message.from || message.from.is_bot || message.sender_chat) return;
    try {
      const [allowed, administrator, target] = await Promise.all([
        this.canDelete(message.chat.id),
        this.isAdmin(message.chat.id, grant.admin_id),
        this.api.getChatMember(message.chat.id, message.from.id),
      ]);
      if (!allowed || !administrator) {
        safety.revoke(message.chat.id, 'permissions_changed');
        return;
      }
      if (target.user.is_bot || target.status === 'administrator' || target.status === 'creator')
        return;
    } catch {
      safety.revoke(message.chat.id, 'permission_check_failed');
      return;
    }
    // No await between the final local guards, durable claim and Telegram request.
    const live = safety.grant(message.chat.id, version);
    if (!live || live.evaluation_id !== grant.evaluation_id || !this.store.isCurrent(messageId))
      return;
    if (!safety.claim(predictionId, live)) return;
    try {
      await this.api.deleteMessage(message.chat.id, message.message_id);
      safety.finish(predictionId, 'DELETED');
    } catch {
      safety.finish(predictionId, 'FAILED_OR_UNKNOWN');
      safety.revoke(message.chat.id, 'delete_failed_or_unknown');
    }
  }

  private async sendCard(
    item: import('./store.ts').ReviewCase,
    title: string,
    commandMessageId: number | null = null,
  ) {
    const entities = JSON.parse(item.metadata).entities ?? [];
    const hiddenLinks = entities
      .filter((entity: { type: string; url?: string }) => entity.type === 'text_link')
      .map((entity: { url: string }) => entity.url)
      .join('\n')
      .slice(0, 600);
    const card = await this.api.sendMessage(
      item.chat_id,
      `${title} (30 минут).\nID: ${item.id}\nВерсия: ${item.revision + 1}\n\n${item.raw_text.slice(0, 2500)}` +
        (hiddenLinks ? `\n\nСкрытые ссылки:\n${hiddenLinks}` : ''),
      {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Удалить / Spam', callback_data: `as:s:${item.id}` },
              { text: 'Оставить / Normal', callback_data: `as:n:${item.id}` },
              { text: 'Пропустить', callback_data: `as:k:${item.id}` },
            ],
          ],
        },
      },
    );
    this.store.bindCard(item.id, card.message_id, commandMessageId);
  }

  async callback(query: CallbackQuery): Promise<void> {
    const match = /^as:([snk]):([0-9a-f-]{36})$/.exec(query.data ?? '');
    if (!match) return;
    const id = match[2] ?? '';
    const card = query.message;
    const item = this.store.getCase(id);
    if (
      !card ||
      !item ||
      !this.config.chatIds.includes(item.chat_id) ||
      card.chat.id !== item.chat_id ||
      card.message_id !== item.card_id ||
      !(await this.isAdmin(item.chat_id, query.from.id))
    ) {
      await this.api.answerCallbackQuery(query.id, { text: 'Нет доступа к этой проверке.' });
      return;
    }
    const verdict: Verdict = match[1] === 's' ? 'spam' : match[1] === 'n' ? 'normal' : 'skip';
    if (verdict === 'spam') {
      // Fail closed when target identity or current membership cannot be checked.
      if (!item.user_id || item.sender_chat_id) {
        await this.api.answerCallbackQuery(query.id, {
          text: 'Нельзя удалить сообщение от имени канала.',
        });
        return;
      }
      try {
        const target = await this.api.getChatMember(item.chat_id, item.user_id);
        if (
          target.status === 'creator' ||
          target.status === 'administrator' ||
          target.user.is_bot
        ) {
          await this.api.answerCallbackQuery(query.id, {
            text: 'Администраторы и боты защищены от удаления.',
          });
          return;
        }
      } catch {
        await this.api.answerCallbackQuery(query.id, {
          text: 'Не удалось проверить автора. Повторите позже.',
        });
        return;
      }
    }
    if (!this.store.resolve(id, query.from.id, verdict)) {
      await this.api.answerCallbackQuery(query.id, {
        text: 'Решение уже принято, проверка истекла или сообщение отредактировано.',
      });
      if (this.store.getCase(id)?.status !== 'PENDING')
        this.cleanup.schedule(item.chat_id, card.message_id, item.command_message_id);
      return;
    }
    let deletion = '';
    if (verdict === 'spam' && item.telegram_message_id !== null) {
      try {
        await this.api.deleteMessage(item.chat_id, item.telegram_message_id);
        this.store.recordDeletion(id, true);
        deletion = ' Сообщение удалено.';
      } catch {
        this.store.recordDeletion(id, false);
        deletion = ' Удаление не удалось; разметка сохранена. Удалите сообщение вручную.';
      }
    }
    // A failed Telegram UI update must never roll back a committed human verdict.
    await this.api.answerCallbackQuery(query.id, { text: 'Решение сохранено.' }).catch(() => {});
    await this.api
      .editMessageText(
        item.chat_id,
        card.message_id,
        `Решение: ${verdict}.${deletion}\nОтмена разметки: /spam undo ${id}`,
        {
          reply_markup: { inline_keyboard: [] },
        },
      )
      .catch(() => {
        console.error('antispam_card_update_failed');
      });
    this.cleanup.schedule(item.chat_id, card.message_id, item.command_message_id);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.cleanup.close();
    this.learning.close();
    this.store.close();
  }
}
