'use strict';
/**
 * Scheduled background jobs (setInterval based, no external scheduler needed):
 *
 *  - Hourly congestion / peak-hour forecast refresh (FR-17): AI /ai/jobs/forecast, falling back
 *    to the JS seasonal baseline. After each refresh, HIGH/CRITICAL forecasts for the coming hour
 *    are pushed to subscribed administrators as `alert` events.
 *  - Nightly maintenance, run once per calendar day (checked every minute, and once at start-up):
 *      * end-of-day closure: unserved WAITING/CALLED/SKIPPED tokens of past days -> NO_SHOW (with
 *        queue events, FR-21), past BOOKED appointments -> NO_SHOW, past OPEN visits -> CLOSED;
 *      * refresh of doctors.avg_consult_minutes = rolling mean of each doctor's last 30 completed
 *        consultations (input of the Eq. 6.2 baseline and the doctor_avg_consult feature).
 *
 * Every timer is unref()'d so it never keeps the process alive, and every run is guarded so a
 * failing job is logged and retried at the next tick instead of crashing the server.
 */
const time = require('./utils/time');
const forecastService = require('./services/forecastService');
const predictionService = require('./services/predictionService');
const queueService = require('./services/queueService');
const analyticsService = require('./services/analyticsService');
const realtime = require('./services/realtime');
const { models, sess } = require('./db');

const FORECAST_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_CHECK_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 3 * 1000;

/** Daily maintenance (end-of-day closure + rolling consult averages). */
async function runDailyMaintenance(db, now = time.clock.now()) {
  const closed = await queueService.endOfDay(db, now);
  const averagesUpdated = await predictionService.refreshDoctorAverages(db);
  return { ...closed, averagesUpdated };
}

/** Forecast refresh followed by `alert` events for HIGH/CRITICAL forecasts of the next hour. */
async function runForecastRefresh(db, now = time.clock.now()) {
  const result = await forecastService.runForecasts(db, { now });
  const horizon = time.formatDateTime(new Date(now.getTime() + 60 * 60 * 1000)).replace(' ', 'T');
  const alerts = await analyticsService.alerts(db, null, now);
  for (const alert of alerts) {
    if (alert.source === 'FORECAST' && alert.at <= horizon) realtime.emitAlert(alert);
  }
  return result;
}

/** True when forecast rows exist for the current hour (no need to refresh at start-up). */
async function hasCurrentForecasts(db, now) {
  const n = await models.Forecast.countDocuments({ forecast_hour: { $gte: time.startOfHour(now) } }).session(sess(db));
  return n > 0;
}

function start(db, { logger = console } = {}) {
  const timers = [];
  const running = new Set();
  let lastMaintenanceDate = null;
  let stopped = false;

  const guarded = (name, fn) => async () => {
    if (stopped || running.has(name)) return;
    running.add(name);
    try {
      const result = await fn();
      if (result !== undefined) logger.log(`[jobs] ${name}: ${JSON.stringify(result)}`);
    } catch (err) {
      logger.error(`[jobs] ${name} failed: ${err && err.message ? err.message : err}`);
    } finally {
      running.delete(name);
    }
  };

  const forecastJob = guarded('forecast-refresh', () => runForecastRefresh(db));
  const dailyJob = guarded('daily-maintenance', async () => {
    const today = time.today();
    if (lastMaintenanceDate === today) return undefined;
    const result = await runDailyMaintenance(db);
    lastMaintenanceDate = today;
    return result;
  });
  const startupForecast = guarded('forecast-startup', async () => {
    if (await hasCurrentForecasts(db, time.clock.now())) return undefined;
    return runForecastRefresh(db);
  });

  const schedule = (fn, ms, repeat) => {
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    timers.push({ t, repeat });
  };

  schedule(dailyJob, STARTUP_DELAY_MS, false);
  schedule(startupForecast, STARTUP_DELAY_MS * 2, false);
  schedule(dailyJob, DAILY_CHECK_INTERVAL_MS, true);
  schedule(forecastJob, FORECAST_INTERVAL_MS, true);

  return {
    stop() {
      stopped = true;
      for (const { t, repeat } of timers) (repeat ? clearInterval : clearTimeout)(t);
      timers.length = 0;
    },
  };
}

module.exports = { start, runDailyMaintenance, runForecastRefresh };
