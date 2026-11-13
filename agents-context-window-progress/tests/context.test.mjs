import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../mods/agents-context/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class Agents','class Agents')
  +'\nglobalThis.api={contextUsage,nextStatusAgent,Agents};';
function element() {
  const node={calls:[],kids:[]};
  let proxy;
  proxy=new Proxy(node,{get(target,key){
    if(key in target) return target[key];
    return (...args)=>{
      node.calls.push([key,...args]);
      if(key==='child') node.kids.push(args[0]);
      if(key==='children') node.kids.push(...args[0]);
      if(key==='when' && args[0]) args[1](proxy);
      return proxy;
    };
  }}); return proxy;
}
const scope={View:class{},div:element,h_flex:element,v_flex:element,svg:element};
vm.createContext(scope); vm.runInContext(source,scope);
const {contextUsage,nextStatusAgent,Agents}=scope.api;
const all=node=>[node,...node.kids.flatMap(child=>typeof child==='object'?all(child):[])];
const call=(node,key)=>node.calls.find(c=>c[0]===key)?.[1];
const theme={accent:'#888888',border:'#333333',foreground:'#ffffff',blocked:'#ff6600',ansi1:'#ff0000',ansi3:'#ffff00'};

test('Codex remaining footer converts to used, strips ANSI and accepts both formats',()=>{
  assert.equal(contextUsage('output\n\x1b[32m77% context left\x1b[0m','codex'),23);
  assert.equal(contextUsage('GPT · context 0% left · weekly 50% left','codex'),100);
  assert.equal(contextUsage('context 100% left','codex'),0);
});
test('ignores conversation percentages, old lines, invalid values and unsupported agents',()=>{
  assert.equal(contextUsage('We have 77% context left in this example','codex'),null);
  assert.equal(contextUsage('context 101% left','codex'),null);
  assert.equal(contextUsage('context 77% left\na\nb\nc\nd','codex'),null);
  assert.equal(contextUsage('context 77% left','claude'),null);
});
test('working glow preserves context fill; blocked pulse replaces glow and preserves percentage',()=>{
  const view=new Agents(); view.contexts={a:{used:36,at:Date.now()}}; view.contextWidths={a:120};
  const working=all(view.withContext(element(),'a',theme,'working'));
  assert.equal(call(working.find(n=>call(n,'id')==='context-fill-a'),'w'),'36%');
  assert.ok(working.some(n=>call(n,'loop')==='left'));
  const blocked=all(view.withContext(element(),'a',theme,'blocked'));
  assert.equal(call(blocked.find(n=>call(n,'id')==='context-fill-a'),'w'),'36%');
  assert.equal(call(blocked.find(n=>call(n,'id')==='context-fill-a'),'bg'),theme.blocked);
  assert.ok(blocked.some(n=>call(n,'loop')==='opacity'));
  assert.ok(!blocked.some(n=>call(n,'loop')==='left'));
  for(const status of ['done','idle']) assert.ok(!all(view.withContext(element(),'a',theme,status)).some(n=>call(n,'loop')));
});
test('expired samples have no colored usage fill',()=>{
  const view=new Agents(); view.contexts={a:{used:36,at:Date.now()-61000}};
  const nodes=all(view.withContext(element(),'a',theme,'idle'));
  assert.equal(call(nodes.find(n=>call(n,'id')==='context-fill-a'),'bg'),undefined);
  assert.match(call(nodes.find(n=>call(n,'id')==='context-a'),'tooltip'),/unavailable/);
});
test('next-status navigation wraps and returns nothing when no target exists',()=>{
  const list=[{address:'a',status:'idle'},{address:'b',status:'working'},{address:'c',status:'idle'}];
  assert.equal(nextStatusAgent(list,'c','idle').address,'a');
  assert.equal(nextStatusAgent(list,'a','working').address,'b');
  assert.equal(nextStatusAgent(list,'a','blocked'),null);
});
