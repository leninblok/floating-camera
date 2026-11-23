const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const reference=require('./reference/native-reference.json');
for(const profile of reference.profiles){
 test(`Tauri shares exact original geometry on ${profile.width}x${profile.height}`,()=>{
  let bounds={x:0,y:0,width:320,height:500};
  const display={id:1,workArea:{x:0,y:0,width:profile.width,height:profile.height}};
  const context=vm.createContext({window:{},matchMedia:()=>({matches:true}),Date,Math});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/native-layout.js'),'utf8'),context);
  const engine=context.window.createKruzhokNative({
   window:{isDestroyed:()=>false,isVisible:()=>false,getBounds:()=>({...bounds}),setBounds:next=>{bounds={...next};}},
   screen:{getPrimaryDisplay:()=>display,getDisplayNearestPoint:()=>display,getAllDisplays:()=>[display]},emit:()=>{},change:()=>{},
  });
  for(const item of profile.cases){engine.setShape(item.shape);engine.setAspect(item.aspect);engine.setSize(item.preset);
   assert.equal(bounds.width,item.width);assert.equal(bounds.height,item.height);
  }
 });
}
