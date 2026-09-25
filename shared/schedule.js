/**
 * schedule.js — reporting week vs automation schedule (two time zones)
 * ====================================================================
 * Two separate concepts, never mixed:
 *
 *   Reporting week    Monday 00:00 → next Monday 00:00 in the STORE time zone
 *                     (settings.store_timezone, America/Los_Angeles). Orders are
 *                     assigned to weeks by their store-local business date.
 *   Automation run    Monday 15:30 in the SCHEDULE time zone
 *                     (settings.schedule_timezone, Asia/Ho_Chi_Minh), as agreed.
 *                     The run covers the previous Monday–Sunday reporting week.
 *
 * Monday 15:30 in Ho Chi Minh (UTC+7, no daylight saving) is 08:30 UTC:
 * Monday 01:30 PDT or 00:30 PST in the store time zone. The reporting week has
 * therefore closed 90 minutes (summer) or 30 minutes (winter) before the run.
 * Nothing here assumes those offsets; they are derived from the IANA zones.
 */
import { addDays, weekStartOf } from './normalized.js';

export const DEFAULT_SCHEDULE = Object.freeze({ timeZone: 'Asia/Ho_Chi_Minh', weekday: 1, time: '15:30' });
export const DEFAULT_REPORTING_TIMEZONE = 'America/Los_Angeles';

const pad = n => String(n).padStart(2, '0');
const noMs = iso => iso.replace(/\.\d{3}Z$/, 'Z');

/** Wall-clock parts of an instant in a zone. */
function partsIn(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset (ms) of a zone at an instant: local wall clock minus UTC. */
function offsetAt(date, timeZone) {
  const p = partsIn(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time (YYYY-MM-DD, HH:MM) in a zone.
 * An ambiguous time (fall-back hour) resolves to the earlier instant. A time
 * inside a spring-forward gap resolves using the pre-transition offset. The
 * times this module uses (00:00 and 15:30) never fall in a gap for these zones.
 */
export function zonedTimeToUtc(ymd, hm, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = String(hm || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsets = [...new Set([offsetAt(new Date(wall - 43_200_000), timeZone), offsetAt(new Date(wall + 43_200_000), timeZone)])];
  const valid = offsets.map(o => wall - o).filter(t => {
    const p = partsIn(new Date(t), timeZone);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi;
  });
  return new Date(valid.length ? Math.min(...valid) : wall - offsets[0]);
}

/** Store-local calendar date (YYYY-MM-DD) of an instant. */
export function localDateOf(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/**
 * A reporting week's exact UTC window: [start, endExclusive). The length is
 * 167, 168 or 169 hours depending on daylight-saving changes inside the week.
 */
export function weekWindowUtc(weekStart, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE) {
  if (weekStartOf(weekStart) !== weekStart) throw new Error('weekStart must be a Monday (YYYY-MM-DD)');
  const start = zonedTimeToUtc(weekStart, '00:00', reportingTimeZone);
  const end = zonedTimeToUtc(addDays(weekStart, 7), '00:00', reportingTimeZone);
  return { weekStart, weekEnd: addDays(weekStart, 6), startUtc: start.toISOString(), endUtcExclusive: end.toISOString(),
           hours: (end - start) / 3600_000 };
}

/** The last reporting week that has fully closed at an instant. */
export function lastClosedWeek(at, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE) {
  const today = localDateOf(at instanceof Date ? at : new Date(at), reportingTimeZone);
  return addDays(weekStartOf(today), -7);
}

/**
 * The scheduled run that covers a reporting week: the first schedule slot
 * (weekday + time in the schedule zone) at or after the week has closed.
 */
export function scheduledRunFor(weekStart, schedule = DEFAULT_SCHEDULE, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE) {
  const { endUtcExclusive } = weekWindowUtc(weekStart, reportingTimeZone);
  const closed = new Date(endUtcExclusive);
  // Start from the schedule-zone date on which the week closes, then walk forward.
  let d = localDateOf(closed, schedule.timeZone);
  for (let i = 0; i < 14; i++, d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== schedule.weekday) continue;
    const slot = zonedTimeToUtc(d, schedule.time, schedule.timeZone);
    if (slot >= closed) return slot;
  }
  throw new Error('No schedule slot found within two weeks');
}

/**
 * Everything a scheduled cycle needs, from one instant: which week it covers,
 * the week's UTC window, when the run is due, and the Shopify search strings
 * (explicit UTC instants, so Shopify never interprets a bare date in its own zone).
 */
export function planCycle(at, { schedule = DEFAULT_SCHEDULE, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE } = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const weekStart = lastClosedWeek(now, reportingTimeZone);
  const win = weekWindowUtc(weekStart, reportingTimeZone);
  const due = scheduledRunFor(weekStart, schedule, reportingTimeZone);
  return {
    ...win,
    reportingTimeZone,
    schedule: { ...schedule },
    scheduledAt: due.toISOString(),
    scheduledAtLocal: `${localDateOf(due, schedule.timeZone)} ${schedule.time} ${schedule.timeZone}`,
    due: now >= due,
    shopify: {
      weekQuery: `created_at:>='${noMs(win.startUtc)}' AND created_at:<'${noMs(win.endUtcExclusive)}'`,
      // Orders created before this week but changed since it started (refunds,
      // edits). Open-ended above, so consecutive cycles overlap and never gap;
      // re-ingesting an unchanged order is a no-op.
      updatedQuery: `updated_at:>='${noMs(win.startUtc)}' AND created_at:<'${noMs(win.startUtc)}'`,
    },
  };
}

// ─── C7: collection time and the retry timeline ───────────────────────────────

/** The Windows collector starts 25 minutes before the first compute attempt (15:05 ICT). */
export const COLLECTION_LEAD_MINUTES = 25;
/**
 * Approved C7 retry policy, relative to the first attempt (Monday 15:30 ICT):
 * every 15 minutes for 3 hours (through 18:30), then hourly until 24 hours
 * after the first attempt (Tuesday 15:30). After that the run is source_timeout.
 */
export const RETRY_POLICY = Object.freeze({ fastEveryMinutes: 15, fastForMinutes: 180, slowEveryMinutes: 60, cutoffAfterMinutes: 1440 });

/** Every attempt instant (UTC ISO) for a week, first attempt included, cutoff last. */
export function retryTimeline(weekStart, schedule = DEFAULT_SCHEDULE, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE, policy = RETRY_POLICY) {
  const first = scheduledRunFor(weekStart, schedule, reportingTimeZone).getTime();
  const out = [];
  for (let m = 0; m <= policy.fastForMinutes; m += policy.fastEveryMinutes) out.push(first + m * 60_000);
  for (let m = policy.fastForMinutes + policy.slowEveryMinutes; m <= policy.cutoffAfterMinutes; m += policy.slowEveryMinutes) out.push(first + m * 60_000);
  return {
    collectionAt: new Date(first - COLLECTION_LEAD_MINUTES * 60_000).toISOString(),
    firstAttemptAt: new Date(first).toISOString(),
    fastUntil: new Date(first + policy.fastForMinutes * 60_000).toISOString(),
    cutoffAt: new Date(first + policy.cutoffAfterMinutes * 60_000).toISOString(),
    attempts: out.map(t => new Date(t).toISOString()),
  };
}

/** The next attempt strictly after `now`, or null when the cutoff has passed. */
export function nextRetryAt(weekStart, now, schedule = DEFAULT_SCHEDULE, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE) {
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  const next = retryTimeline(weekStart, schedule, reportingTimeZone).attempts.find(a => Date.parse(a) > t);
  return next || null;
}

/** True once the week's retry window is over. */
export function pastCutoff(weekStart, now, schedule = DEFAULT_SCHEDULE, reportingTimeZone = DEFAULT_REPORTING_TIMEZONE) {
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  return t >= Date.parse(retryTimeline(weekStart, schedule, reportingTimeZone).cutoffAt);
}
