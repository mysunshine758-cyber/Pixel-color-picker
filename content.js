(() => {
  if(globalThis.__pixelPickerStable)return;
  globalThis.__pixelPickerStable=true;
  let current, appliedRevision = -1;
  chrome.runtime.onMessage.addListener((m, sender, reply)=>{
    if(m.type!=='setActive')return;
    if(m.revision < appliedRevision){reply?.({revision:appliedRevision});return;}
    appliedRevision=m.revision;
    m.active?start():stop();
    reply?.({revision:appliedRevision});
    return true;
  });
  function stop(options={}){
    const s=current;if(!s)return;current=null;s.stopped=true;s.revision++;
    s.abort.abort();
    for(const key of ['timer','noticeTimer','rightTimer',...(options.keepContextMenu?[]:['menuSuppressTimer'])]){
      if(s[key])clearTimeout(s[key]);s[key]=0;
    }
    if(s.raf){cancelAnimationFrame(s.raf);s.raf=0;}
    if(s.menuSuppressor && !options.keepContextMenu){removeEventListener('contextmenu',s.menuSuppressor,true);s.menuSuppressor=null;}
    s.host?.remove();
    s.canvas=null;s.excluded=null;s.point=null;s.width=0;s.height=0;s.hex=null;s.busy=false;s.dirty=false;
  }
  function start(){
    const s=current={abort:new AbortController(),revision:0,busy:false,dirty:true,point:null,canvas:null,hex:null,rightDown:false,longPress:false};
    s.host=document.createElement('div');
    s.host.style.cssText='all:initial!important;position:fixed!important;left:0!important;top:0!important;z-index:2147483647!important;pointer-events:none!important';
    const root=s.host.attachShadow({mode:'closed'});
    root.innerHTML='<style>.card{position:fixed;box-sizing:border-box;width:190px;padding:12px;border-radius:10px;background:#17191d;color:#f7f8fa;font:11px system-ui;pointer-events:none}.row{display:flex;align-items:center;gap:8px}.swatch{width:24px;height:24px;border:1px solid #ffffff55;border-radius:5px}.hex{font:bold 20px monospace}.hint{color:#aeb4bf;margin-top:7px}</style><div class="card" hidden><div class="row"><span class="swatch"></span><span class="hex">—</span></div><div class="hint">Right-click to copy · Esc to exit</div></div>';
    s.card=root.querySelector('.card');s.label=root.querySelector('.hex');s.swatch=root.querySelector('.swatch');s.hint=root.querySelector('.hint');
    document.documentElement.append(s.host);
    const on=(name,fn)=>addEventListener(name,fn,{capture:true,signal:s.abort.signal});
    on('pointermove',e=>{s.point={x:e.clientX,y:e.clientY};s.dirty=true;visual(s);schedule(s);});
    on('mousedown',e=>{
      if(e.button!==2)return;
      s.rightDown=true;s.longPress=false;
      clearTimeout(s.rightTimer);
      s.rightTimer=setTimeout(()=>{
        if(current===s && s.rightDown){
          s.longPress=true;
          s.menuSuppressor=e=>{e.preventDefault();e.stopImmediatePropagation();clearTimeout(s.menuSuppressTimer);s.menuSuppressTimer=0;removeEventListener('contextmenu',s.menuSuppressor,true);s.menuSuppressor=null;};
          addEventListener('contextmenu',s.menuSuppressor,{capture:true,once:true});
          s.menuSuppressTimer=setTimeout(()=>{removeEventListener('contextmenu',s.menuSuppressor,true);s.menuSuppressor=null;s.menuSuppressTimer=0;},1200);
          stop({keepContextMenu:true});chrome.runtime.sendMessage({type:'deactivateAll'}).catch(()=>{});
        }
      },800);
    });
    on('mouseup',e=>{
      if(e.button!==2)return;
      s.rightDown=false;clearTimeout(s.rightTimer);s.rightTimer=0;
    });
    on('contextmenu',e=>{
      e.preventDefault();e.stopImmediatePropagation();
      if(s.longPress)return;
      const value=s.hex;
      if(!value){notice(s,'Waiting for a valid pixel');return;}
      // Capture the displayed value synchronously, before any asynchronous work.
      copy(value,s).then(()=>notice(s,'Copied '+value),()=>notice(s,'Copy failed — clipboard unavailable'));
    });
    on('keydown',e=>{if(e.key==='Escape'){e.preventDefault();stop();chrome.runtime.sendMessage({type:'deactivateAll'}).catch(()=>{});}});
    const invalidate=()=>{s.revision++;s.canvas=null;show(s,null);s.dirty=true;visual(s);schedule(s);};
    on('scroll',invalidate);on('resize',invalidate);on('pagehide',stop);
    on('visibilitychange',()=>{if(document.hidden)stop();});
  }
  async function copy(value,s){
    try {await navigator.clipboard.writeText(value);return;} catch {}
    if(current!==s)throw Error('Inactive');
    const field=document.createElement('textarea'),focused=document.activeElement;
    field.value=value;field.style.cssText='position:fixed;left:-10000px;top:0';
    // The temporary field is removed even when copying fails.
    document.documentElement.append(field);
    try{field.select();if(!document.execCommand('copy'))throw Error('Copy denied');}
    finally{field.remove();focused?.focus({preventScroll:true});}
  }
  function notice(s,text){
    if(current!==s)return;s.hint.textContent=text;clearTimeout(s.noticeTimer);
    s.noticeTimer=setTimeout(()=>{if(current===s)s.hint.textContent='Right-click to copy · Esc to exit';},1500);
  }
  function show(s,value){
    if(s.hex===value)return;s.hex=value;s.label.textContent=value||'—';s.swatch.style.background=value||'transparent';
  }
  function visual(s){
    if(current!==s || s.stopped || s.raf)return;
    s.raf=requestAnimationFrame(()=>{s.raf=0;if(current!==s || s.stopped || !s.point)return;
      // Freeze only card position during capture; never hide it or alter the cursor.
      if(!s.busy){
        s.card.hidden=false;
        const w=s.card.offsetWidth,h=s.card.offsetHeight,p=s.point;
        s.card.style.left=Math.max(0,p.x+w+16<innerWidth?p.x+16:p.x-w-16)+'px';
        s.card.style.top=Math.max(0,p.y+h+16<innerHeight?p.y+16:p.y-h-16)+'px';
      }
      pixel(s);
    });
  }
  function pixel(s){
    if(current!==s || s.stopped || !s.canvas || !s.point)return;
    const p=s.point,r=s.excluded;
    // The captured card rectangle is permanently excluded from this frame.
    if(p.x<0 || p.y<0 || p.x>=s.width || p.y>=s.height ||
       (p.x>=r.left-2 && p.x<=r.right+2 && p.y>=r.top-2 && p.y<=r.bottom+2)){
      show(s,null);s.dirty=true;schedule(s);return;
    }
    const x=Math.floor(p.x*s.canvas.width/s.width),y=Math.floor(p.y*s.canvas.height/s.height);
    const rgb=s.canvas.getContext('2d').getImageData(x,y,1,1).data;
    show(s,'#'+[...rgb].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase());
  }
  function schedule(s,delay=0){
    if(current!==s || s.timer || s.busy || !s.point)return;
    s.timer=setTimeout(()=>{s.timer=0;capture(s);},Math.max(delay,(s.next||0)-Date.now()));
  }
  async function capture(s){
    if(current!==s || s.stopped || !s.dirty)return;
    s.busy=true;s.dirty=false;
    const revision=s.revision,width=innerWidth,height=innerHeight,excluded=s.card.getBoundingClientRect();
    try{
      const result=await chrome.runtime.sendMessage({type:'capture'});
      if(current!==s || s.stopped)return;
      if(result?.retry){s.dirty=true;s.next=Date.now()+result.retry;return;}
      if(!result?.data)throw Error('Capture unavailable');
      const bitmap=await createImageBitmap(await(await fetch(result.data)).blob());
      try{
        if(current!==s || s.stopped || revision!==s.revision)return;
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        canvas.getContext('2d',{willReadFrequently:true}).drawImage(bitmap,0,0);
        s.canvas=canvas;s.width=width;s.height=height;s.excluded=excluded;
        pixel(s);
      }finally{bitmap.close();}
      s.next=Date.now()+650;
    }catch{
      if(current===s && !s.stopped){s.canvas=null;show(s,null);notice(s,'Capture unavailable');}
      if(!chrome.runtime?.id)stop();
    }finally{
      s.busy=false;
      if(current===s && !s.stopped){visual(s);if(s.dirty)schedule(s);}
    }
  }
})();
