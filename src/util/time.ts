const MS_PER_DAY = 86_400_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** ISO-8601 week key, e.g. `2026-W27`. Weeks are Monday-based, in UTC. */
export function isoWeekKey(date: Date): string {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = current.getUTCDay() || 7;

  current.setUTCDate(current.getUTCDate() + 4 - dayNumber);

  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((current.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);

  return `${current.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/** Render a mute length in the largest natural Russian unit. */
export function formatDuration(minutes: number): string {
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    return `${days} ${pluralizeRu(days, ['день', 'дня', 'дней'])}`;
  }

  if (minutes % MINUTES_PER_HOUR === 0) {
    const hours = minutes / MINUTES_PER_HOUR;
    return `${hours} ${pluralizeRu(hours, ['час', 'часа', 'часов'])}`;
  }

  return `${minutes} ${pluralizeRu(minutes, ['минуту', 'минуты', 'минут'])}`;
}

/** Russian pluralisation: `forms` is [one, few, many]. */
export function pluralizeRu(value: number, forms: [string, string, string]): string {
  const abs = Math.abs(value);
  const lastTwo = abs % 100;
  const last = abs % 10;

  if (lastTwo >= 11 && lastTwo <= 14) {
    return forms[2];
  }

  if (last === 1) {
    return forms[0];
  }

  if (last >= 2 && last <= 4) {
    return forms[1];
  }

  return forms[2];
}
