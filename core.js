export const defaults = () => ({version: 1, automatic: false, interval: 60, rules: []});

export function validate(input) {
  if (!input || input.version !== 1 || typeof input.automatic !== 'boolean' ||
      !Number.isInteger(input.interval) || input.interval < 1 || input.interval > 525600 ||
      !Array.isArray(input.rules)) throw new Error('Invalid settings: interval must be 1–525600 minutes.');
  const rules = input.rules.map(rule => {
    if (!rule || !['both', 'url', 'title', 'domain'].includes(rule.field) ||
        !['remove', 'keep'].includes(rule.action) || typeof rule.enabled !== 'boolean' ||
        typeof rule.caseSensitive !== 'boolean' || typeof rule.value !== 'string' || !rule.value.trim()) {
      throw new Error('Each rule needs a non-empty value and valid field, action, and switches.');
    }
    const interval = rule.interval ?? null;
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 525600)) {
      throw new Error('Rule interval must be 1–525600 minutes or the default.');
    }
    let value = rule.value.trim();
    if (rule.field === 'domain') {
      if (/[\s/:?#@*]/u.test(value)) throw new Error('Enter a domain only, such as example.com.');
      try { value = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, ''); }
      catch { throw new Error('Invalid domain.'); }
    }
    return {field: rule.field, action: rule.action, enabled: rule.enabled, caseSensitive: rule.caseSensitive, value, interval};
  });
  return {version: 1, automatic: input.automatic, interval: input.interval, rules};
}

function match(item, rule) {
  if (rule.field === 'domain') {
    try {
      const host = new URL(item.url).hostname.toLowerCase().replace(/\.$/, '');
      return host === rule.value || host.endsWith(`.${rule.value}`);
    } catch { return false; }
  }
  let url = item.url || '';
  try { url += `\n${decodeURIComponent(url.replace(/\+/g, ' '))}`; } catch { /* Keep the raw URL. */ }
  const source = rule.field === 'title' ? item.title || '' : rule.field === 'url' ? url : `${url}\n${item.title || ''}`;
  return rule.caseSensitive ? source.includes(rule.value) : source.toLowerCase().includes(rule.value.toLowerCase());
}

export function shouldRemove(item, rules) {
  if (!item.url) return false;
  const active = rules.filter(rule => rule.enabled);
  return active.some(rule => rule.action === 'remove' && match(item, rule)) &&
    !active.some(rule => rule.action === 'keep' && match(item, rule));
}

// Chrome's end time is exclusive and visit timestamps can be ahead of the JS clock.
// Scan through JavaScript's maximum date so the wall clock cannot exclude stored visits.
export async function scanHistory(history, endOfHistory = 8_640_000_000_000_001, limit = 10000) {
  const found = new Map();
  const windows = [[0, endOfHistory]];
  while (windows.length) {
    const [startTime, endTime] = windows.pop();
    const items = await history.search({text: '', startTime, endTime, maxResults: limit});
    if (items.length >= limit) {
      if (endTime - startTime <= 1) throw new Error('History is too dense to scan completely. No cleanup started.');
      const middle = startTime + Math.floor((endTime - startTime) / 2);
      windows.push([startTime, middle], [middle, endTime]);
    } else {
      for (const item of items) {
        if (!item.url) continue;
        const previous = found.get(item.url);
        if (!previous || (item.lastVisitTime || 0) > (previous.lastVisitTime || 0)) found.set(item.url, item);
      }
    }
  }
  return [...found.values()];
}

export async function findHistoryMatches(history, rules) {
  const items = await scanHistory(history);
  const matches = items.filter(item => shouldRemove(item, rules));

  // getVisits can verify a redirect source omitted by search, but cannot supply
  // its title. Skip these extra candidates when a Protect rule needs the title.
  if (rules.some(rule => rule.enabled && rule.action === 'keep' &&
      (rule.field === 'title' || rule.field === 'both'))) return matches;

  const checked = new Set(items.map(item => item.url));
  for (const rule of rules) {
    if (!rule.enabled || rule.action !== 'remove' ||
        (rule.field !== 'url' && rule.field !== 'both') ||
        !/^https?:\/\/[^/\s]/i.test(rule.value) || !URL.canParse(rule.value)) continue;
    const {href: url} = new URL(rule.value);
    const item = {url};
    if (checked.has(url) || !match(item, rule) || !shouldRemove(item, rules)) continue;
    checked.add(url);
    if ((await history.getVisits({url})).length) matches.push(item);
  }
  return matches;
}
