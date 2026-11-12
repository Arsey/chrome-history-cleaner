import {defaults, validate} from './core.js';
import {messages} from './messages.js';

const preferredLanguage = chrome.i18n.getUILanguage();
const baseLanguage = preferredLanguage.split('-')[0];
const {uiLanguage} = await chrome.storage.local.get('uiLanguage').catch(() => ({}));
const languagePreference = Object.hasOwn(messages, uiLanguage) ? uiLanguage : 'auto';
const language = languagePreference !== 'auto' ? languagePreference
  : Object.hasOwn(messages, preferredLanguage) ? preferredLanguage
  : Object.hasOwn(messages, baseLanguage) ? baseLanguage : 'en';
const t = (key, ...args) => messages[language][key].replace(/\$(\d+)/g, (_, index) => args[Number(index) - 1]);
document.documentElement.lang = language;
for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);

const $ = id => document.getElementById(id);
let config = defaults();
let preview = null;
let dirty = false;
let busy = false;
let revision = 0;
const errorKeys = {
  "Invalid settings: interval must be 1–525600 minutes.": "errConfig",
  "Each rule needs a non-empty value and valid field, action, and switches.": "errRule",
  "Rule interval must be 1–525600 minutes or the default.": "errInterval",
  "Enter a domain only, such as example.com.": "errDomainOnly",
  "Invalid domain.": "errDomain",
  "History is too dense to scan completely. No cleanup started.": "errDense",
  "Settings changed in another tab. Reload this page before saving.": "errStale",
  "Scan cancelled. Preview again.": "errCancel",
  "Too many matches for one preview. Narrow your rules and try again. Nothing was removed.": "errTooMany",
  "Chrome could not store the preview. Narrow your rules and try again. Nothing was removed.": "errStore",
  "Preview expired. Preview matches again before cleaning.": "errExpired",
  "Unknown action.": "errUnknown",
  "Operation failed. Cleanup may be incomplete. Preview again.": "errFailed",
  "Cleanup was interrupted. Some entries may already have been removed. Check the last cleanup and preview again.": "errInterrupted",
  "This file is not valid JSON.": "errImport"
};
const errorText = message => Object.hasOwn(errorKeys, message) ? t(errorKeys[message]) : message;
const status = text => { $('status').textContent = text; };
const languageNames = {
  en: 'English', uk: 'Українська', nl: 'Nederlands', de: 'Deutsch',
  fr: 'Français', es: 'Español', it: 'Italiano', pl: 'Polski',
  'pt-BR': 'Português (Brasil)', ja: '日本語', ko: '한국어'
};
const languageSelect = $('language');
languageSelect.add(new Option(t('sameAsChrome'), 'auto'));
for (const [code, name] of Object.entries(languageNames)) {
  const option = new Option(name, code);
  option.lang = code;
  languageSelect.add(option);
}
languageSelect.value = languagePreference;
languageSelect.addEventListener('change', async () => {
  if (busy || dirty) {
    languageSelect.value = languagePreference;
    if (dirty) status(t('saveBeforeLanguage'));
    return;
  }

  await task(async () => {
    try {
      await chrome.storage.local.set({uiLanguage: languageSelect.value});
      location.reload();
    } catch {
      languageSelect.value = languagePreference;
      throw new Error(t('languageSaveFailed'));
    }
  });
});
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || t('noResponse'));
  return response.result;
}
function invalidate() {
  dirty = true;
  preview = null;
  $('clean').disabled = true;
  $('matches').replaceChildren();
  $('previewSummary').textContent = t('savePreview');
  $('saved').textContent = t('unsaved');
}
function control(tag, values, selected) {
  const select = document.createElement(tag);
  for (const [value, text] of values) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text; select.append(option);
  }
  select.value = selected;
  return select;
}
function label(text, input, className = '') {
  const element = document.createElement('label');
  element.className = className;
  element.append(document.createTextNode(text), input);
  return element;
}
const matchCopy = {
  both: {placeholder: t('placeholderBoth'), condition: t('conditionBoth')},
  url: {placeholder: t('placeholderUrl'), condition: t('conditionUrl')},
  title: {placeholder: t('placeholderTitle'), condition: t('conditionTitle')},
  domain: {placeholder: t('placeholderDomain'), condition: t('conditionDomain')}
};

function renderRules() {
  $('rules').replaceChildren();
  $('empty').hidden = config.rules.length > 0;
  config.rules.forEach((rule, index) => {
    const row = document.createElement('div'); row.className = `rule ${rule.action}`;
    const action = control('select', [['remove',t('remove')],['keep',t('protect')]], rule.action);
    const field = control('select', [['both',t('both')],['url',t('url')],['title',t('title')],['domain',t('domain')]], rule.field);
    const value = document.createElement('input'); value.type = 'text'; value.value = rule.value;
    const valueLabel = label('', value, 'value');
    const hint = document.createElement('p');
    hint.className = 'rule-hint';
    hint.id = `rule-hint-${index + 1}`;
    value.setAttribute('aria-describedby', hint.id);
    const timing = control('select', [['default',t('inherit')],['custom',t('custom')]],
      rule.interval == null ? 'default' : 'custom');
    timing.setAttribute('aria-label', t('automatic'));
    const minutes = document.createElement('input');
    minutes.type = 'number'; minutes.min = '1'; minutes.max = '525600'; minutes.step = '1';
    minutes.value = rule.interval ?? config.interval;
    const timingRow = document.createElement('div');
    timingRow.className = 'rule-timing';
    const minuteLabel = label(t('minutes'), minutes);
    timingRow.append(label(t('automatic'), timing), minuteLabel);
    timing.onchange = () => {
      rule.interval = timing.value === 'default' ? null : Number(minutes.value);
      updateRuleCopy(); invalidate();
    };
    minutes.oninput = () => { rule.interval = Number(minutes.value); updateRuleCopy(); invalidate(); };
    function updateRuleCopy() {
      const copy = matchCopy[rule.field];
      timingRow.hidden = rule.action === 'keep';
      minuteLabel.hidden = timing.value !== 'custom';

      valueLabel.firstChild.nodeValue = rule.field === 'domain' ? t('domain') : t('contains');
      value.placeholder = copy.placeholder;
      const interval = rule.interval ?? Number($('interval').value);
      const schedule = interval === 1 ? t('timingOne') : t('timingHint', String(interval));
      hint.textContent = !rule.enabled ? t('ruleOff') : rule.action === 'keep'
        ? t('keepHint', copy.condition)
        : t('removeHint', copy.condition) + ' ' + schedule;
    }
    updateRuleCopy();
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled;
    const sensitive = document.createElement('input'); sensitive.type = 'checkbox'; sensitive.checked = rule.caseSensitive;
    sensitive.disabled = rule.field === 'domain';
    for (const [element, key] of [[action,'action'],[field,'field'],[value,'value'],[enabled,'enabled'],[sensitive,'caseSensitive']]) {
      element.addEventListener('input', () => {
        rule[key] = element.type === 'checkbox' ? element.checked : element.value;
        row.className = `rule ${rule.action}`;
        sensitive.disabled = rule.field === 'domain';
        updateRuleCopy();
        invalidate();
      });
    }
    const remove = document.createElement('button'); remove.textContent = '×'; remove.className = 'remove-rule'; remove.setAttribute('aria-label', t('deleteRule', String(index + 1)));
    remove.onclick = () => { config.rules.splice(index, 1); renderRules(); invalidate(); };
    const secondary = document.createElement('div'); secondary.className = 'secondary';
    secondary.append(label(t('enabled'), enabled), label(t('case'), sensitive));
    const options = document.createElement('div'); options.className = 'rule-options';
    options.append(timingRow, secondary);
    row.append(label(t('action'), action), label(t('matchIn'), field), valueLabel, remove, options, hint);
    $('rules').append(row);
  });
}
function renderConfig() {
  $('automatic').checked = config.automatic;
  $('interval').value = config.interval;
  renderRules();
}
function collect() {
  return validate({...config, automatic: $('automatic').checked, interval: Number($('interval').value)});
}
async function refreshRun() {
  const result = await request({type:'state'});
  $('lastRun').textContent = result.lastRun
    ? new Date(result.lastRun.time).toLocaleString() + ' · ' + t('result', String(result.lastRun.deleted), String(result.lastRun.failed))
    : t('noCleanup');
  $('lastError').textContent = result.lastError && (!result.lastRun || result.lastError.time > result.lastRun.time) ? errorText(result.lastError.message) : '';
}
async function task(work) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('main button, main input, main select, #language')];
  const disabled = controls.map(element => element.disabled);
  controls.forEach(element => { if (element.id !== 'stop') element.disabled = true; });
  try { await work(); } catch (error) { status(errorText(error.message)); }
  finally {
    controls.forEach((element, index) => { element.disabled = disabled[index]; });
    $('clean').disabled = !preview?.count || dirty;
    busy = false;
  }
}
$('add').onclick = () => {
  config.rules.push({field:'both', action:'remove', value:'', enabled:true, caseSensitive:false});
  renderRules(); invalidate();
  $('rules').lastElementChild.querySelector('input[type=text]').focus();
};
$('stop').onclick = async () => {
  try {
    const result = await request({type:'stop'});
    const hadUnsavedChanges = dirty;
    invalidate();
    if (!hadUnsavedChanges) {
      revision = result.revision;
      config = result.settings;
      dirty = false;
      renderConfig();
    }
    config.automatic = false;
    $('automatic').checked = false;
    $('saved').textContent = t('autoOff');
    status(t('stopped'));
  } catch (error) { status(errorText(error.message)); }
};
$('automatic').onchange = invalidate;
$('interval').oninput = () => { config.interval = Number($('interval').value); renderRules(); invalidate(); };
$('save').onclick = () => task(async () => {
  const result = await request({type:'save', settings:collect(), revision});
  revision = result.revision; config = result.settings; dirty = false; preview = null; renderConfig();
  $('saved').textContent = config.automatic ? t('autoOn') : t('autoOff');
  status(t('saved'));
});
$('preview').onclick = () => task(async () => {
  if (dirty) throw new Error(t('saveFirst'));
  status(t('scanning'));
  preview = await request({type:'preview'});
  $('matches').replaceChildren();
  for (const item of preview.items) {
    const li = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = item.title || t('untitled');
    const url = document.createElement('span'); url.textContent = item.url;
    li.append(title, url); $('matches').append(li);
  }
  $('previewSummary').textContent = (preview.count === 1 ? t('matchOne') : t('matches', String(preview.count)))
    + ' ' + (preview.count > 300 ? t('matchLimit') : t('matchAll'));
  status(t('previewReady'));
});
$('clean').onclick = () => {
  if (!preview?.count || busy) return;
  $('confirmText').textContent = t('selected', String(preview.count));
  $('confirm').showModal();
};
$('confirm').onclose = () => {
  if ($('confirm').returnValue !== 'remove') return;
  task(async () => {
    const token = preview?.token; preview = null;
    status(t('removing'));
    const result = await request({type:'clean', token});
    $('matches').replaceChildren(); $('previewSummary').textContent = t('previewAgain');
    status((result.cancelled ? t('cancelled') + ' ' : '') + t('result', String(result.deleted), String(result.failed))); await refreshRun();
  });
};
$('export').onclick = () => task(async () => {
  const {settings} = await request({type:'state'});
  const blob = new Blob([JSON.stringify(settings, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'chrome-history-cleaner-rules.json';
  document.body.append(link);
  link.click();
  link.remove();
  // Let Chrome open the file before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  status(dirty ? t('downloadDirty') : t('download'));
});
$('import').onchange = event => task(async () => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const raw = await file.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(t('errImport')); }
    const imported = validate(parsed);
    imported.automatic = false;
    const result = await request({type:'save', settings:imported, revision});
    revision = result.revision; config = result.settings; renderConfig(); invalidate(); dirty = false;
    $('saved').textContent = t('imported');
    status(t('importStatus'));
  } finally { $('import').value = ''; }
});
await task(async () => {
  const result = await request({type:'state'}); revision = result.revision; config = result.settings; renderConfig();
  $('saved').textContent = config.automatic ? t('autoOn') : t('autoOff');
  await refreshRun();
});

languageSelect.disabled = false;
