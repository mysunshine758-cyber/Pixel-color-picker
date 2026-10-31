const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
test('repeated injection/toggle, Escape, navigation and visibility cleanup',()=>{
  let message,listeners=0;const events=new Map(),hosts=new Set(),timers=new Set();
  const element=()=>({style:{},remove(){hosts.delete(this);},attachShadow(){return {set innerHTML(v){},querySelector(){return {style:{},textContent:''};}};}});
  const document={hidden:false,createElement:element,documentElement:{append(e){hosts.add(e);}}};
  const context=vm.createContext({document,AbortController,chrome:{runtime:{sendMessage(){return Promise.resolve();},onMessage:{addListener(fn){message=fn;listeners++;}}}},
    addEventListener(name,fn,{signal}={}){events.set(name,fn);signal?.addEventListener('abort',()=>events.delete(name));},removeEventListener(name){events.delete(name)},
    clearTimeout(id){timers.delete(id);},setTimeout(fn){timers.add(fn);return fn;},cancelAnimationFrame(){},
    requestAnimationFrame(){return 1;}});
  const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
  vm.runInContext(source,context);vm.runInContext(source,context);assert.equal(listeners,1);
  message({type:'setActive',active:true});
  assert.ok(events.has('mousedown'));assert.ok(events.has('mouseup'));assert.ok(events.has('contextmenu'));
  assert.equal(events.has('blur'),false);
  assert.equal(events.has('click'),false);
  let prevented=false;events.get('contextmenu')({preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert.equal(prevented,true);assert.equal(hosts.size,1);
  message({type:'setActive',active:false});message({type:'setActive',active:true});
  events.get('mousedown')({button:2});assert.equal(timers.size,1);
  [...timers][0]();assert.equal(hosts.size,0);assert.equal(events.size,0);assert.equal(timers.size,1);
  [...timers].forEach(fn=>{timers.delete(fn);fn();});assert.equal(timers.size,0);
  message({type:'setActive',active:true});
  message({type:'setActive',active:false});assert.equal(hosts.size,0);assert.equal(events.size,0);
  for(let i=0;i<20;i++){message({type:'setActive',active:true});assert.equal(hosts.size,1);message({type:'setActive',active:false});assert.equal(hosts.size,0);assert.equal(events.size,0);}
  for(const name of ['keydown','pagehide','visibilitychange']){
    message({type:'setActive',active:true});document.hidden=true;
    events.get(name)({key:'Escape',preventDefault(){}});
    assert.equal(hosts.size,0);assert.equal(events.size,0);assert.equal(timers.size,0);
  }
});
