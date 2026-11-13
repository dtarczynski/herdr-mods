import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../mods/github-issues/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ')
  .replace('export default class GithubIssues', 'class GithubIssues')
  + '\nglobalThis.api = { issueTask, workingIssueUrls, workingIssueAgents, focusWorkingIssue, workingIndicator };';
function harness() {
  let live = [], current = null;
  const calls = [];
  const scope = { View: class {}, terminals: () => live, focused: () => ({agent:current}), run: (command,args) => calls.push({command,args}) };
  vm.createContext(scope); vm.runInContext(source, scope);
  return { api: scope.api, calls, scope, setLive(value) { live=value; }, setFocused(value) { current=value; } };
}

test('issue progress follows live working status and disappears on completion, blocking or exit', () => {
  const { api } = harness();
  const issue = { number: 165, url: 'https://github.com/owner/a/issues/165', title: 'Task' };
  const terminal = { address: 't1', state: 'live', status: 'working', argv: ['zsh', '-lic', 'codex', api.issueTask(issue, 'owner/a')] };
  assert.deepEqual([...api.workingIssueUrls([terminal])], [issue.url]);
  for (const status of ['idle', 'blocked', 'done', 'error', null])
    assert.equal(api.workingIssueUrls([{ ...terminal, status }]).size, 0);
  assert.equal(api.workingIssueUrls([{ ...terminal, state: 'finished' }]).size, 0);
  assert.equal(api.workingIssueUrls([]).size, 0);
  assert.equal(api.workingIssueUrls([terminal, { ...terminal, address: 't2' }]).size, 1);
});

test('issue progress isolates repository and host, ignoring titles and body references', () => {
  const { api } = harness();
  const task = (url, owner = 'owner/a', number = 165) => api.issueTask({ number, url, title: 'Same title' }, owner);
  const terminal = argv => ({ address: 't1', state: 'live', status: 'working', argv });
  assert.deepEqual([...api.workingIssueUrls([terminal([task('https://git.example/owner/b/issues/165', 'owner/b')])])], ['https://git.example/owner/b/issues/165']);
  for (const arg of [
    '#165 · Same title',
    'Review these notes:\n' + task('https://github.com/owner/a/issues/165'),
    task('https://github.com/owner/b/issues/165'),
    task('https://github.com/owner/a/issues/166'),
    task('https://github.com/owner/a/pull/165'),
  ]) assert.equal(api.workingIssueUrls([terminal([arg])]).size, 0);
  assert.deepEqual([...api.workingIssueUrls([terminal([task('https://GitHub.com/Owner/A/issues/165/')])])], ['https://github.com/owner/a/issues/165']);
});

test('working children inherit the explicit issue association using machine-qualified parent addresses', () => {
  const { api } = harness();
  const url = 'https://github.com/owner/a/issues/165';
  const parent = { address: 'remote/t1', state: 'live', status: 'idle', argv: [api.issueTask({number:165, url, title:'Task'}, 'owner/a')] };
  const child = { address: 'remote/t2', parent: 'remote/t1', state: 'live', status: 'working', argv: ['codex'] };
  assert.deepEqual([...api.workingIssueUrls([parent, child])], [url]);
  assert.equal(api.workingIssueUrls([parent, { ...child, parent: 't1' }]).size, 0);
  assert.equal(api.workingIssueUrls([{ ...parent, state: 'finished' }, child]).size, 0);
  assert.equal(api.workingIssueUrls([{ ...child, parent: child.address }]).size, 0);
});


test('spinner focuses the exact task owner, preserves matching focus, and rechecks live status', () => {
  const h=harness(),url='https://github.com/owner/a/issues/165';
  const parent={address:'remote/t1',state:'live',status:'working',argv:[h.api.issueTask({number:165,url,title:'Task'},'owner/a')]};
  const child={address:'remote/t2',parent:'remote/t1',state:'live',status:'working',argv:['codex']};
  h.setLive([child,parent]);h.api.focusWorkingIssue(url);
  assert.equal(h.calls[0].command,'agent.focus');assert.equal(h.calls[0].args.terminal,'remote/t1');
  h.setFocused('remote/t2');h.api.focusWorkingIssue(url);
  assert.equal(h.calls[1].args.terminal,'remote/t2');
  h.setLive([child,{...parent,status:'idle'}]);h.setFocused(null);h.api.focusWorkingIssue(url);
  assert.equal(h.calls[2].args.terminal,'remote/t2');
  h.setLive([{...parent,status:'done'}]);h.api.focusWorkingIssue(url);
  h.setLive([parent]);h.api.focusWorkingIssue(url.replace('owner/a','other/a'));
  assert.equal(h.calls.length,3);
});

test('spinner click consumes the row click and does not open issue details', () => {
  const h=harness(),url='https://github.com/owner/a/issues/165',handlers={};
  const element=new Proxy({}, {get:(_,key)=>(...args)=>{
    if (key==='on_click') handlers.click=args[0];
    if (key==='on_mouse_down') handlers.down=args[1];
    return element;
  }});
  h.scope.div=()=>element;h.scope.svg=()=>element;h.scope.theme=()=>({working:'gold'});
  h.setLive([{address:'t1',state:'live',status:'working',argv:[h.api.issueTask({number:165,url,title:'Task'},'owner/a')]}]);
  h.api.workingIndicator(165,url);
  let stopped=0;const cx={stop_propagation(){stopped++;}};
  handlers.down({},cx);handlers.click({},cx);
  assert.equal(stopped,2);assert.equal(h.calls.length,1);assert.equal(h.calls[0].command,'agent.focus');
});
