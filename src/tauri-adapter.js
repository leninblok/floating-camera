/* Tauri platform binding for the renderer protocol shared with the website. */
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const handlers = new Map();
  let engine, configuration, monitors = [], bounds = {x:0,y:0,width:320,height:500};
  let visible = false, disposed = false, cursor = {x:-1,y:-1}, cameraDevices = [];
  let pendingBounds = null, writing = null, persistTimer = null, menuTimer = null, smokeStarted = false;
  let lastSaved = {};
  const emit = (channel,...args) => handlers.get(channel)?.(...args);
  function writeBounds(value) {
    bounds = {...value}; pendingBounds = {...value};
    if (!writing) {
      writing = (async()=> {
        while (pendingBounds && !disposed) {
          const next = pendingBounds; pendingBounds = null;
          await invoke('apply_bounds',{bounds:next});
        }
      })().catch(error=>{console.error('Window update failed:',error);}).finally(()=>{writing=null;if(pendingBounds&&!disposed)writeBounds(pendingBounds);});
    }
    clearTimeout(persistTimer); persistTimer=setTimeout(()=>void save(),140);
  }
  async function flush(){while(writing)await writing;}
  function displayFor(point) {
    return monitors.reduce((nearest,display)=>{
      const distance=m=>{const a=m.workArea;return Math.max(a.x-point.x,0,point.x-a.x-a.width)**2+Math.max(a.y-point.y,0,point.y-a.y-a.height)**2;};
      return distance(display)<distance(nearest)?display:nearest;
    });
  }
  function state(){return {...engine.getState(),cameraDevices};}
  async function save(){
    if(!engine||disposed)return;
    const s=state();
    const settings={shapeMode:s.shapeMode,aspectRatio:s.aspectRatio,sizePresetId:s.sizePresetId,
      borderEnabled:s.borderEnabled,shadowEnabled:s.shadowEnabled,mirrorEnabled:s.mirrorEnabled,cameraDeviceId:s.cameraDeviceId,
      x:s.focusEnabled?lastSaved.x:bounds.x,y:s.focusEnabled?lastSaved.y:bounds.y};
    lastSaved=settings;
    await invoke('save_settings',{settings});
  }
  function changed(){
    clearTimeout(menuTimer);
    menuTimer=setTimeout(()=>{void invoke('sync_menu',{state:state()}).catch(console.error);},80);
    void save().catch(console.error);
  }
  async function refreshDisplay(){
    const next=await invoke('bootstrap');monitors=next.monitors;
    if(monitors.length)engine.resize();
  }
  function fakeCamera(){
    let calls=0;
    navigator.mediaDevices.getUserMedia=async constraints=>{
      if(constraints.audio!==false)throw new Error('Audio capture must remain disabled');
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const ctx=canvas.getContext('2d');
      const stream=canvas.captureStream(30);
      const draw=()=>{ctx.fillStyle=calls%2?'#6550aa':'#417365';ctx.fillRect(0,0,640,360);};
      draw();const timer=setInterval(draw,33);
      const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{clearInterval(timer);stop();};
      calls++;return stream;
    };
    navigator.mediaDevices.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'smoke-camera',label:'Artificial test camera',groupId:'test'}];
  }
  const boot=(async()=>{
    configuration=await invoke('bootstrap');monitors=configuration.monitors;lastSaved=configuration.settings;
    if(!monitors.length)throw new Error('No displays available');
    if(configuration.smoke)fakeCamera();
    engine=window.createKruzhokNative({
      settings:configuration.settings,
      window:{isDestroyed:()=>disposed,isVisible:()=>visible,getBounds:()=>({...bounds}),setBounds:writeBounds,
        setPosition:(x,y)=>writeBounds({...bounds,x,y})},
      screen:{getPrimaryDisplay:()=>monitors[0],getDisplayNearestPoint:displayFor,getAllDisplays:()=>monitors},
      emit,change:changed,
    });
    await listen('camera:cursor',event=>{cursor=event.payload;emit('camera:sync-mouse-hit');});
    await listen('camera:display-changed',()=>{void refreshDisplay().catch(console.error);});
    await listen('camera:action',event=>{
      const command=event.payload,s=state();
      if(command.startsWith('camera:'))engine.setCamera(command==='camera:auto'?null:command.slice(7),true);
      else if(command.startsWith('shape:'))engine.setShape(command.slice(6));
      else if(command.startsWith('aspect:'))engine.setAspect(command.slice(7));
      else if(command.startsWith('size:'))engine.setSize(command.slice(5));
      else if(command==='mirror')engine.setMirror(!s.mirrorEnabled);
      else if(command==='border')engine.setBorder(!s.borderEnabled);
      else if(command==='shadow')setShadow(!s.shadowEnabled);
      else if(command==='focus')engine.toggleFocus();
    });
    writeBounds(engine.initialBounds());await flush();
    await invoke('sync_menu',{state:state()});
    const privacy=document.getElementById('privacyButton');
    if(privacy)privacy.textContent=configuration.platform==='macos'?'Настройки macOS':'Доступ к камере';
    return engine.getState();
  })();
  async function setShadow(enabled){engine.setShadow(enabled);if(configuration.platform==='macos')await invoke('set_shadow',{enabled});}
  const api=window.electronAPI={
    markStartup(phase){
      if(configuration?.smoke&&phase==='camera-frame'&&!smokeStarted){smokeStarted=true;setTimeout(()=>void smoke(),200);}
    },
    async getInitialState(){await boot;return {...engine.getState(),nativeShadow:configuration.platform==='macos'};},
    async getBounds(){await boot;engine.interrupt();await flush();return {...bounds};},
    getCursorInWindow:async()=>({...cursor}),
    setMouseEventsEnabled(enabled){void invoke('mouse_events',{enabled}).catch(console.error);},
    moveWindow(position){engine.move(position);},
    async stepLayout(id,timestamp){const more=engine.step(id,timestamp);await flush();if(!more)void invoke('refresh_shadow');return more;},
    async toggleFocus(){engine.toggleFocus();},
    async finishMove(){await flush();await refreshDisplay();engine.finishMove();},
    async revealWindow(){await flush();visible=true;await invoke('reveal');},
    ensureCameraAccess:async()=>({granted:true}),
    openCameraPrivacySettings:()=>invoke('camera_privacy'),
    async setCameraDeviceId(id){engine.setCamera(id,false);},
    async syncCameraDevices(devices){
      const seen=new Set();cameraDevices=devices.filter(device=>device.id&&device.id.length<=1024&&!seen.has(device.id)&&seen.add(device.id))
        .map((device,index)=>({id:device.id,label:(device.label?.trim()||`Камера ${index+1}`).slice(0,256)}));changed();
    },
  };
  for(const [name,channel] of Object.entries({
    onAnimateLayout:'camera:animate-layout',onCancelLayout:'camera:cancel-layout',onSyncMouseHit:'camera:sync-mouse-hit',
    onSetMirror:'camera:set-mirror',onSetBorder:'camera:set-border',onSetShadow:'camera:set-shadow',onSizeChanged:'camera:size-changed',
    onSetShape:'camera:set-shape',onSetFocus:'camera:set-focus',onSetCameraDevice:'camera:set-device',
  }))api[name]=handler=>handlers.set(channel,handler);
  document.addEventListener('contextmenu',event=>{event.preventDefault();if(engine)void invoke('context_menu',{state:state()}).catch(console.error);});
  window.addEventListener('beforeunload',()=>{disposed=true;clearTimeout(persistTimer);clearTimeout(menuTimer);engine?.dispose();});
  // Packaging smoke runs only with the explicit native --smoke-test flag and
  // uses a canvas camera; it never requests access to a user's real devices.
  async function smoke(){
    const checks=[];
    const assert=(condition,name)=>{if(!condition)throw new Error(name);checks.push(name);};
    const settled=async()=>{
      for(let i=0;i<90;i++){
        await new Promise(resolve=>requestAnimationFrame(resolve));await flush();
        if(!writing&&JSON.stringify(bounds)===previous){await new Promise(r=>setTimeout(r,50));if(JSON.stringify(bounds)===previous)return;}
        var previous=JSON.stringify(bounds);
      }
      throw new Error('Native layout did not settle');
    };
    try{
      assert(document.body.classList.contains('has-video'),'first camera frame');
      assert(state().shapeMode==='rectangle'&&state().aspectRatio==='9:16','fresh app defaults');
      for(const shape of ['circle','rectangle']){
        engine.setShape(shape);
        for(const aspect of shape==='circle'?['1:1']:['1:1','4:5','9:16']){
          engine.setAspect(aspect);
          for(const preset of state().sizes){
            engine.setSize(preset.id);await settled();
            const actual=await invoke('native_status');
            assert(Math.abs(actual.bounds.width-bounds.width)<=1&&Math.abs(actual.bounds.height-bounds.height)<=1,`native bounds ${shape} ${aspect} ${preset.id}`);
            assert(Math.abs(document.getElementById('cameraShell').clientWidth-(bounds.width-88))<=1,'webview geometry');
          }
        }
      }
      engine.setShape('circle');engine.setSize('compact');await settled();
      const restore={...bounds};engine.setFocus(true);await settled();
      assert(document.getElementById('circle').classList.contains('locked'),'focus locks drag');
      engine.setFocus(false);await settled();assert(JSON.stringify(bounds)===JSON.stringify(restore),'focus restores position');
      engine.setBorder(true);engine.setMirror(true);await new Promise(r=>setTimeout(r,180));
      assert(document.body.classList.contains('border-enabled'),'border');assert(document.getElementById('cam').classList.contains('mirror'),'mirror');
      const target={x:bounds.x-30,y:bounds.y+10};engine.move(target);await flush();engine.finishMove();await settled();
      const status=await invoke('native_status');assert(status.alwaysOnTop,'native always-on-top');
      await save();assert((await invoke('bootstrap')).settings.borderEnabled,'settings persisted');
      await invoke('smoke_report',{report:{ok:true,checks,platform:configuration.platform,version:configuration.version,cornerShape:CSS.supports('corner-shape','superellipse(1.5)')}});
    }catch(error){await invoke('smoke_report',{report:{ok:false,checks,error:String(error),stack:error.stack}});}
  }
})();
