const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function loadWorker(storage={}){
  const events={};let activeHandler;
  const calls=[];const tabs=[{id:1},{id:2},{id:3}];
  const chrome={action:{onClicked:{addListener(fn){events.click=fn;}},setTitle:async()=>{}},tabs:{
    onActivated:{addListener(fn){events.activated=fn;}},onCreated:{addListener(fn){events.created=fn;}},onUpdated:{addListener(fn){events.updated=fn;}},onRemoved:{addListener(fn){events.removed=fn;}},
    query:async()=>tabs,get:async id=>({id,windowId:1,active:true}),sendMessage:async(id,m)=>{calls.push(['message',id,m]);return {revision:m.revision};},captureVisibleTab:async()=> 'data:',
  },scripting:{executeScript:async({target})=>calls.push(['inject',target.tabId])},storage:{local:{get:async()=>({pickerState:storage.state}),set:async v=>{storage.state=v.pickerState;}}},runtime:{onMessage:{addListener(fn){activeHandler=fn;}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),{chrome,Set,Date,Math,Error,Promise});
  return {events,calls,chrome,send:(m,s={tab:{id:1},frameId:0})=>activeHandler(m,s,()=>{})};
}
test('toolbar activation synchronizes existing tabs and later tab lifecycle events',async()=>{
  const w=loadWorker();await w.events.click();
  assert.deepEqual(w.calls.filter(x=>x[0]==='message').map(x=>x[1]).sort(),[1,2,3]);
  w.calls.length=0;w.events.activated({tabId:2});w.events.created({id:4});w.events.updated(1,{status:'complete'});await new Promise(setImmediate);
  assert.ok(w.calls.filter(x=>x[0]==='message').length>=3);
});
test('escape/deactivateAll turns off global state and syncs all tabs',async()=>{
  const w=loadWorker();await w.events.click();w.calls.length=0;w.send({type:'deactivateAll'});await new Promise(setImmediate);
  assert.deepEqual(w.calls.filter(x=>x[0]==='message').map(x=>x[2].active),[false,false,false]);
});
test('persisted state survives a worker restart and stale messages cannot win',async()=>{
  const storage={};const first=loadWorker(storage);await first.events.click();assert.equal(storage.state.active,true);
  const second=loadWorker(storage);await second.events.activated({tabId:3});await new Promise(setImmediate);
  assert.equal(second.calls.find(x=>x[0]==='message'&&x[1]===3)[2].active,true);
  second.send({type:'deactivateAll'});await new Promise(setImmediate);assert.equal(storage.state.active,false);assert.ok(storage.state.revision>1);
});
test('a newer OFF state reconciles after an older ON sync finishes',async()=>{
  const w=loadWorker();let release;const gate=new Promise(r=>release=r);
  const original=w.chrome.tabs.sendMessage;w.chrome.tabs.sendMessage=async(id,m)=>{if(m.active)await gate;return original(id,m);};
  const on=w.events.click();await new Promise(setImmediate);const off=w.events.click();release();await Promise.all([on,off]);await new Promise(setImmediate);
  const messages=w.calls.filter(x=>x[0]==='message'&&x[1]===1).map(x=>x[2].active);assert.equal(messages.at(-1),false);
});
test('capture gate prevents overlap and inactive tabs fail',async()=>{
  const w=loadWorker();let reply;const pending=new Promise(r=>reply=r);w.chrome.tabs.captureVisibleTab=async()=>{await pending;return 'data:';};
  const result=w.send({type:'capture'});const retry=w.send({type:'capture'}, {tab:{id:1},frameId:0});assert.equal(retry,undefined);reply();await result;
});
test('manifest has global-state runtime files and no content script duplicates',()=>{
  const dir=path.join(__dirname,'..'),m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
  assert.equal(m.version,'1.1.6');assert.equal(m.manifest_version,3);assert.ok(!m.content_scripts);assert.ok(m.permissions.includes('storage'));assert.deepEqual(m.host_permissions,['<all_urls>']);
  assert.ok(fs.existsSync(path.join(dir,m.background.service_worker)));assert.ok(fs.existsSync(path.join(dir,'content.js')));
});
