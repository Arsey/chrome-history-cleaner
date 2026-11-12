import {defaults, validate, shouldRemove, scanHistory} from './core.js';
export const alarmName = 'history-cleanup';
export const previewLifetime = 10 * 60 * 1000;
export const previewByteLimit = 4 * 1024 * 1024;

export class UserError extends Error {}

export function createEngine(api, now = Date.now) {
  let tail = Promise.resolve();
  let generation = 0;
  const serial = work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  async function state() {
    const stored = await api.storage.local.get(['settings', 'revision', 'lastRun', 'lastError']);
    return {...stored, revision: stored.revision || 0, settings: validate(stored.settings || defaults())};
  }
  async function schedule(config, reset = false) {
    const {timings} = await api.storage.local.get('timings');
    const active = config.rules.map((rule, index) => ({rule, index}))
      .filter(({rule}) => rule.enabled && rule.action === 'remove');
    if (!config.automatic || !active.length) {
      await api.alarms.clear(alarmName);
      await api.storage.local.remove('timings');
      return [];
    }
    const previousDue = new Map((timings || []).map(entry => [entry.index, entry.due]));
    const deadlines = active.map(({rule, index}) => ({
      index,
      interval: rule.interval ?? config.interval,
      due: !reset && previousDue.get(index) ||
        now() + (rule.interval ?? config.interval) * 60000
    }));
    await api.storage.local.set({timings: deadlines});
    const next = deadlines.reduce((earliest, entry) => Math.min(earliest, entry.due), Infinity);
    const period = deadlines.reduce((shortest, entry) => Math.min(shortest, entry.interval), Infinity);
    const alarm = await api.alarms.get(alarmName);
    if (reset || !alarm || alarm.scheduledTime !== next || alarm.periodInMinutes !== period) {
      // The repeating alarm retries after worker interruption; each completed run sets the next deadline.
      await api.alarms.create(alarmName, {when: Math.max(now() + 1000, next), periodInMinutes: period});
    }
    return deadlines;
  }
  async function clean(urls, runGeneration) {
    let deleted = 0;
    let failed = 0;
    for (const url of urls) {
      if (generation !== runGeneration) break;
      try { await api.history.deleteUrl({url}); deleted++; }
      catch { failed++; }
    }
    const lastRun = {time: now(), deleted, failed, cancelled: generation !== runGeneration};
    await api.storage.local.set({lastRun});
    await api.storage.local.remove('lastError');
    return lastRun;
  }
  async function automatic(runGeneration) {
    const {settings} = await state();
    if (generation !== runGeneration || !settings.automatic) return;
    const deadlines = await schedule(settings);
    const due = new Set(deadlines.filter(entry => entry.due <= now()).map(entry => entry.index));
    if (!due.size) return;
    const rules = settings.rules.filter((rule, index) => rule.action === 'keep' || due.has(index));
    const items = await scanHistory(api.history);
    await api.storage.session.remove('preview');
    const result = await clean(items.filter(item => shouldRemove(item, rules)).map(item => item.url), runGeneration);
    if (!result.cancelled) {
      await api.storage.local.set({timings: deadlines.map(entry =>
        due.has(entry.index) ? {...entry, due: now() + entry.interval * 60000} : entry)});
      await schedule(settings);
    }
    return result;
  }
  async function handle(message, runGeneration) {
    if (message.type === 'state') return state();
    if (message.type === 'stop') {
      const current = await state();
      const settings = {...current.settings, automatic: false};
      await api.storage.local.set({settings, revision: current.revision + 1});
      await api.storage.session.remove('preview');
      await schedule(settings);
      return state();
    }
    if (message.type === 'save') {
      const current = await state();
      if (message.revision !== current.revision) {
        throw new UserError('Settings changed in another tab. Reload this page before saving.');
      }
      const settings = validate(message.settings);
      await api.storage.local.set({settings, revision: current.revision + 1});
      await api.storage.session.remove('preview');
      await schedule(settings, true);
      return {settings, revision: current.revision + 1};
    }
    if (message.type === 'preview') {
      await api.storage.session.remove('preview');
      const current = await state();
      const items = (await scanHistory(api.history)).filter(item => shouldRemove(item, current.settings.rules));
      if (generation !== runGeneration) throw new UserError('Scan cancelled. Preview again.');
      const token = crypto.randomUUID();
      const preview = {token, urls: items.map(item => item.url), revision: current.revision, expires: now() + previewLifetime};
      // Budget UTF-16 strings conservatively below Chrome's session-memory quota.
      if (JSON.stringify(preview).length * 2 > previewByteLimit) {
        throw new UserError('Too many matches for one preview. Narrow your rules and try again. Nothing was removed.');
      }
      try { await api.storage.session.set({preview}); }
      catch {
        throw new UserError('Chrome could not store the preview. Narrow your rules and try again. Nothing was removed.');
      }
      return {token, count: items.length, items: items.slice(0, 300)};
    }
    if (message.type === 'clean') {
      const current = await state();
      const {preview} = await api.storage.session.get('preview');
      await api.storage.session.remove('preview');
      if (!preview || preview.token !== message.token || preview.revision !== current.revision || now() >= preview.expires) {
        throw new UserError('Preview expired. Preview matches again before cleaning.');
      }
      return clean(preview.urls, runGeneration);
    }
    throw new UserError('Unknown action.');
  }
  return {
    request: message => {
      if (message.type === 'stop' || message.type === 'save') generation++;
      const runGeneration = generation;
      return serial(() => handle(message, runGeneration));
    },
    initialize: () => serial(async () => {
      await api.storage.session.remove('preview');
      await schedule((await state()).settings);
    }),
    runAutomatic: () => {
      const runGeneration = generation;
      return serial(() => automatic(runGeneration));
    },
    recordError: async () => api.storage.local.set({lastError: {time: now(), message: 'Cleanup was interrupted. Some entries may already have been removed. Check the last cleanup and preview again.'}})
  };
}
