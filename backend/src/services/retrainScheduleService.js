'use strict';
/**
 * FR-22 scheduled retraining. The Hospital Administrator picks OFF / DAILY / WEEKLY and an hour
 * (settings.retrainSchedule); the jobs runner calls runIfDue() every minute. A due run calls the
 * AI service's normal retrain job, so the Section 6.7.3 acceptance rules decide activation exactly
 * as for a manual retrain. The outcome is remembered in settings key `lastScheduledRetrain`.
 */
const time = require('../utils/time');
const settingsService = require('./settingsService');
const ai = require('./aiClient');
const { models } = require('../db');

const { Setting } = models;
const LAST_KEY = 'lastScheduledRetrain';

/** Is `now` inside the scheduled hour (and day) of `schedule`? */
function isDueSlot(schedule, now) {
  if (!schedule || schedule.frequency === 'OFF') return false;
  if (now.getHours() !== schedule.hour) return false;
  return schedule.frequency === 'DAILY' || time.isoDow(now) === schedule.dayOfWeek;
}

/** Next scheduled start (Date) after `now`, or null when the schedule is off. */
function nextRunAt(schedule, now) {
  if (!schedule || schedule.frequency === 'OFF') return null;
  for (let add = 0; add <= 8; add += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, schedule.hour, 0, 0);
    if (d <= now) continue;
    if (schedule.frequency === 'DAILY' || time.isoDow(d) === schedule.dayOfWeek) return d;
  }
  return null;
}

async function lastRun() {
  const row = await Setting.findById(LAST_KEY).lean();
  return row ? row.value : null;
}

/** GET /admin/models/schedule */
async function status(db, now = time.clock.now()) {
  const { retrainSchedule } = await settingsService.getSettings(db);
  const next = nextRunAt(retrainSchedule, now);
  return { schedule: retrainSchedule, nextRunAt: next ? time.toApi(next) : null, lastRun: await lastRun() };
}

/** Run the retrain when the schedule is due and it has not run in this slot yet. */
async function runIfDue(db, now = time.clock.now()) {
  const { retrainSchedule } = await settingsService.getSettings(db);
  if (!isDueSlot(retrainSchedule, now)) return undefined;
  const last = await lastRun();
  const slotKey = `${time.formatDate(now)} ${String(retrainSchedule.hour).padStart(2, '0')}`;
  if (last && last.slot === slotKey) return undefined;
  // Claim the slot first so a slow training run is never started twice in the same hour.
  await Setting.updateOne(
    { _id: LAST_KEY },
    { $set: { value: { slot: slotKey, startedAt: time.toApi(now), status: 'RUNNING' }, updated_at: time.dbDate(now) } },
    { upsert: true }
  );
  let outcome;
  try {
    const r = await ai.retrain();
    outcome = {
      slot: slotKey,
      startedAt: time.toApi(now),
      status: r.accepted ? 'ACCEPTED' : 'REJECTED',
      version: r.version,
      activated: Boolean(r.activated),
      reason: r.reason || null,
      mae: r.metrics ? r.metrics.mae : null,
    };
  } catch (err) {
    outcome = { slot: slotKey, startedAt: time.toApi(now), status: 'FAILED', error: err && err.message ? err.message : String(err) };
  }
  await Setting.updateOne({ _id: LAST_KEY }, { $set: { value: outcome, updated_at: time.dbDate(time.clock.now()) } }, { upsert: true });
  return outcome;
}

module.exports = { status, runIfDue, isDueSlot, nextRunAt };
