import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, validate, shouldRemove, scanHistory} from '../core.js';
import {createEngine, alarmName} from '../engine.js';
const rule = (value, changes = {}) => ({value, field:'both', action:'remove', enabled:true, caseSensitive:false, ...changes});
const item = (url, title = '') => ({url, title});

test('defaults disable automatic deletion; config accepts thousands of rules', () => {
  assert.equal(defaults().automatic, false);
  assert.equal(validate({...defaults(), rules:Array.from({length:15000}, () => rule('sample'))}).rules.length, 15000);
});
test('reject malformed and empty rules, invalid intervals, malformed domain', () => {
  for (const config of [{...defaults(), interval:0}, {...defaults(), interval:1.5}, {...defaults(), rules:[rule('  ')]}, {...defaults(), rules:[rule('example.com/path',{field:'domain'})]}]) {
    assert.throws(() => validate(config));
  }
});
test('keyword scopes, case sensitivity, URL decoding and exclusion priority', () => {
  assert.equal(shouldRemove(item('https://example.com/?q=%D0%BA%D1%96%D1%82'), [rule('кіт')]), true);
  assert.equal(shouldRemove(item('https://example.com', 'Secret'), [rule('secret', {field:'title'})]), true);
  assert.equal(shouldRemove(item('https://example.com', 'Secret'), [rule('secret', {field:'url'})]), false);
  assert.equal(shouldRemove(item('https://example.com', 'Secret'), [rule('secret', {caseSensitive:true})]), false);
  assert.equal(shouldRemove(item('https://example.com', 'Secret'), [rule('secret'), rule('example.com',{action:'keep'})]), false);
  assert.equal(shouldRemove(item('https://example.com'), [rule('example', {enabled:false})]), false);
  assert.equal(shouldRemove(item('https://example.com'), []), false);
});
test('domain boundaries include subdomains but not suffix lookalikes', () => {
  const rules = validate({...defaults(),rules:[rule('Example.com', {field:'domain'})]}).rules;
  for (const url of ['https://example.com', 'https://www.example.com']) assert.equal(shouldRemove(item(url),rules),true);
  for (const url of ['https://notexample.com', 'https://example.com.attacker.org', 'https://other.org/?example.com']) assert.equal(shouldRemove(item(url),rules),false);
});
test('scan splits capped results and deduplicates inclusive boundaries', async () => {
  const items = Array.from({length:21}, (_, n) => ({url:`https://example.org/${n}`,lastVisitTime:n*10}));
  let searches = 0;
  const result = await scanHistory({search:async q => {
    searches++;
    assert.equal(q.text,'');
    return items.filter(i => i.lastVisitTime >= q.startTime && i.lastVisitTime <= q.endTime).slice(0,q.maxResults);
  }},201,5);
  assert.equal(result.length,21); assert.ok(searches > 1);
});
test('scan fails closed on unresolvable saturation', async () => {
  await assert.rejects(scanHistory({search:async () => Array.from({length:5},(_,n)=>item(`https://x/${n}`))},2,5), /too dense/);
});
function fakeApi(historyItems = []) {
  const data = {local:{timings:[{index:0, due:1}]},session:{}};
  const area = name => ({
    get:async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,data[name][key]])),
    set:async values => Object.assign(data[name], structuredClone(values)),
    remove:async key => { delete data[name][key]; }
  });
  const removed = []; let alarm;
  return {data,removed,
    storage:{local:area('local'),session:area('session')},
    alarms:{get:async()=>alarm,create:async(name,details)=>{alarm={name,...details};},clear:async()=>{alarm=undefined;}},
    history:{search:async()=>historyItems,deleteUrl:async({url})=>{removed.push(url);}},
  };
}
test('manual cleanup requires preview, removes exactly previewed matches once', async () => {
  const api = fakeApi([item('https://delete.example'),item('https://keep.example')]);
  const engine = createEngine(api);
  await engine.request({type:'save',revision:0,settings:{...defaults(),rules:[rule('delete')]}});
  await assert.rejects(engine.request({type:'clean',token:'made-up'}),/expired/);
  const preview = await engine.request({type:'preview'});
  assert.equal(preview.count,1); assert.equal(api.removed.length,0);
  const result = await engine.request({type:'clean',token:preview.token});
  assert.equal(result.deleted,1); assert.deepEqual(api.removed,['https://delete.example']);
  await assert.rejects(engine.request({type:'clean',token:preview.token}),/expired/);
});
test('saving rules invalidates preview, automation off clears alarm', async () => {
  const api = fakeApi([item('https://delete.example')]); const engine = createEngine(api);
  const config = {...defaults(),automatic:true,rules:[rule('delete')]};
  await engine.request({type:'save',revision:0,settings:config});
  assert.equal((await api.alarms.get(alarmName)).periodInMinutes,60);
  const preview = await engine.request({type:'preview'});
  await engine.request({type:'save',revision:1,settings:{...config,automatic:false}});
  assert.equal(await api.alarms.get(alarmName),undefined);
  await assert.rejects(engine.request({type:'clean',token:preview.token}),/expired/);
  await engine.runAutomatic(); assert.equal(api.removed.length,0);
});
test('startup repairs missing alarm; automatic cleanup respects keep rules and partial failures', async () => {
  const api = fakeApi([item('https://remove.one'),item('https://remove.keep'),item('https://remove.fail')]);
  api.data.local.settings = {...defaults(),automatic:true,rules:[rule('remove'),rule('keep',{action:'keep'})]};
  api.history.deleteUrl = async ({url}) => { if(url.endsWith('fail')) throw new Error('private URL'); api.removed.push(url); };
  const engine = createEngine(api); await engine.initialize();
  assert.equal((await api.alarms.get(alarmName)).periodInMinutes,60);
  const result = await engine.runAutomatic();
  assert.equal(result.deleted,1); assert.equal(result.failed,1); assert.deepEqual(api.removed,['https://remove.one']);
  assert.equal(JSON.stringify(api.data.local).includes('private URL'),false);
});
test('simultaneous automatic jobs serialize and do not overlap history access', async () => {
  const api = fakeApi(); let active = 0; let peak = 0;
  api.data.local.settings = {...defaults(),automatic:true,rules:[rule('remove')]};
  api.history.search = async () => { active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,5)); active--; return []; };
  const engine = createEngine(api);
  await Promise.all([engine.runAutomatic(),engine.runAutomatic(),engine.runAutomatic()]);
  assert.equal(peak,1);
});

test('stop during a scan cancels this run and queued automatic runs', async () => {
  const api = fakeApi();
  api.data.local.settings = {...defaults(), automatic:true, rules:[rule('remove')]};
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  api.history.search = async () => { began(); await gate; return [item('https://remove.example')]; };
  const engine = createEngine(api);
  const running = engine.runAutomatic();
  await started;
  const queued = engine.runAutomatic();
  const stopped = engine.request({type:'stop'});
  release();
  await Promise.all([running, queued, stopped]);
  assert.deepEqual(api.removed, []);
  assert.equal(api.data.local.settings.automatic, false);
});

test('stop between deletions prevents remaining URLs from being removed', async () => {
  const api = fakeApi([item('https://remove.one'), item('https://remove.two')]);
  api.data.local.settings = {...defaults(), automatic:true, rules:[rule('remove')]};
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  api.history.deleteUrl = async ({url}) => { api.removed.push(url); began(); await gate; };
  const engine = createEngine(api);
  const running = engine.runAutomatic();
  await started;
  const stopped = engine.request({type:'stop'});
  release();
  const result = await running;
  await stopped;
  assert.equal(result.cancelled, true);
  assert.deepEqual(api.removed, ['https://remove.one']);
});

test('stale saves cannot overwrite protection or re-enable a stopped schedule', async () => {
  const api = fakeApi();
  const engine = createEngine(api);
  await engine.request({type:'save', revision:0, settings:{...defaults(), rules:[rule('safe', {action:'keep'})]}});
  await assert.rejects(engine.request({type:'save', revision:0, settings:{...defaults(), automatic:true}}), /another tab/);
  assert.equal(api.data.local.settings.rules[0].action, 'keep');
  await engine.request({type:'stop'});
  await assert.rejects(engine.request({type:'save', revision:1, settings:{...defaults(), automatic:true}}), /another tab/);
  assert.equal(api.data.local.settings.automatic, false);
});

test('preview expires, stores only URLs, and cannot survive worker initialization', async () => {
  const api = fakeApi([item('https://remove.example', 'private title')]);
  api.data.local.settings = {...defaults(), rules:[rule('remove')]};
  let time = 1000;
  const engine = createEngine(api, () => time);
  const preview = await engine.request({type:'preview'});
  assert.equal(JSON.stringify(api.data.session).includes('private title'), false);
  time += 600000;
  await assert.rejects(engine.request({type:'clean', token:preview.token}), /expired/);
  assert.deepEqual(api.removed, []);
  await engine.request({type:'preview'});
  await engine.initialize();
  assert.equal(api.data.session.preview, undefined);
});

test('oversized or failed previews invalidate earlier tokens and explain recovery', async () => {
  const api = fakeApi([item('https://remove.example')]);
  api.data.local.settings = {...defaults(), rules:[rule('remove')]};
  const engine = createEngine(api);
  const previous = await engine.request({type:'preview'});
  api.history.search = async () => [item('https://remove.example/' + 'a'.repeat(2200000))];
  await assert.rejects(engine.request({type:'preview'}), /Too many matches/);
  await assert.rejects(engine.request({type:'clean', token:previous.token}), /expired/);
  api.history.search = async () => [item('https://remove.example')];
  api.storage.session.set = async () => { throw new Error('quota'); };
  await assert.rejects(engine.request({type:'preview'}), /could not store/);
  assert.deepEqual(api.removed, []);
});

test('old settings inherit the default; invalid custom intervals are rejected', () => {
  assert.equal(validate({...defaults(), rules:[rule('x')]}).rules[0].interval, null);
  for (const interval of [0, -1, 1.5, '30', 525601]) {
    assert.throws(() => validate({...defaults(), rules:[rule('x', {interval})]}));
  }
  assert.equal(validate({...defaults(), rules:[rule('x', {interval:120})]}).rules[0].interval, 120);
});

test('only due removal rules run, Protect always applies, deadlines survive restart', async () => {
  const api = fakeApi([item('https://fast.example'), item('https://slow.example'), item('https://fast.safe')]);
  let clock = 1000;
  const engine = createEngine(api, () => clock);
  const settings = {...defaults(), automatic:true, interval:10, rules:[
    rule('fast', {interval:2}), rule('slow'), rule('safe', {action:'keep', interval:999})
  ]};
  await engine.request({type:'save', revision:0, settings});
  await engine.runAutomatic();
  assert.deepEqual(api.removed, []);
  clock += 120000;
  await engine.runAutomatic();
  assert.deepEqual(api.removed, ['https://fast.example']);
  const saved = structuredClone(api.data.local.timings);
  const restarted = createEngine(api, () => clock);
  await restarted.initialize();
  assert.deepEqual(api.data.local.timings, saved);
  clock = 601000;
  await restarted.runAutomatic();
  assert.deepEqual(api.removed, ['https://fast.example','https://fast.example','https://slow.example']);
  assert.equal(api.removed.includes('https://fast.safe'), false);
  await restarted.request({type:'stop'});
  assert.equal(api.data.local.timings, undefined);
});

test('manual preview includes all rules regardless of their deadlines; save resets intervals', async () => {
  const api = fakeApi([item('https://fast.example'), item('https://slow.example')]);
  let clock = 1000;
  const engine = createEngine(api, () => clock);
  const settings = {...defaults(), automatic:true, rules:[rule('fast',{interval:1}),rule('slow',{interval:1440})]};
  await engine.request({type:'save', revision:0, settings});
  const preview = await engine.request({type:'preview'});
  assert.equal(preview.count, 2);
  await engine.request({type:'clean', token:preview.token});
  assert.equal(api.removed.length, 2);
  clock += 30000;
  await engine.request({type:'save', revision:1, settings});
  assert.equal(api.data.local.timings[0].due, clock + 60000);
});
