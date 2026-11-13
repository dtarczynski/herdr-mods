import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise the real mod's async boundaries and launch payload without starting agents.
const source = readFileSync(new URL('../mods/github-issues/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ')
  .replace('export default class GithubIssues', 'class GithubIssues')
  + '\nglobalThis.api = { GithubIssues, launchDefaults, defaultSelection, agentArgv, agentKind, launchModes, issueTask, pullRequestsFromEvents, prState, prIcon };';
function harness({props = {}, defaults = null, choices = []} = {}) {
  let cwd = '/repo/a';
  const calls = [], pending = [], jobs = [], overlays = [], opened = [];
  const writes=[],bindings=[],store=new Map([['github-issues.launch-defaults.v1',defaults]]);
  const input = (options={}) => {
    let value=options.value || '';
    const handlers=new Map();
    return { value: () => value, set_value(next) {value=next;}, on(event,handler) {handlers.set(event,handler);}, emit(event,cx) {handlers.get(event)?.({},cx);} };
  };
  const scope = {
    View: class {}, InputState: { new: input }, TextareaState: {new:input},
    props: () => ({ overlay: 'reader', ...props }),
    shared: key=>store.get(key), setShared: (key,value)=>{writes.push({key,value});store.set(key,value);},
    knownAgents: async ()=>choices,
    spaces: () => [{ id: 'space-a', active: true, folder: cwd }],
    focused: () => ({ pane: 'pane-a', cwd }), panes: () => [{ pane: 'pane-a', cwd }],
    exec: (command, args, options) => new Promise(resolve => pending.push({ command, args, options, resolve })),
    nextCommand: () => new Promise(() => {}),
    run: (name, args) => calls.push({ name, args }), closeOverlay: id => overlays.push(id), openOverlay: spec => opened.push(spec),
  };
  vm.createContext(scope); vm.runInContext(source, scope);
  const cx = { notify() {}, focus_handle:()=>({focus(){}}), bind_keys: values=>bindings.push(...values), timer: { every() {} }, spawn(fn) { jobs.push(fn(cx)); } };
  const view = new scope.api.GithubIssues();
  view.init({}, cx);
  return { view, cx, calls, pending, jobs, overlays, opened, writes, store, bindings, api: scope.api, setCwd(value) { cwd = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const result = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const repo = { nameWithOwner: 'owner/a', url: 'https://github.com/owner/a' };

test('stale response cannot overwrite a newly selected repository', async () => {
  const h = harness();
  h.setCwd('/repo/b'); h.view.refresh(h.cx);
  h.pending[0].resolve(result(repo)); await settle();
  h.pending[1].resolve(result({ ...repo, nameWithOwner: 'owner/b' })); await settle();
  h.pending[3].resolve(result([{ number: 2 }])); await settle();
  h.pending[2].resolve(result([{ number: 1 }])); await settle();
  assert.equal(h.view.repo.nameWithOwner, 'owner/b');
  assert.equal(h.view.items[0].number, 2);
  assert.equal(h.view.target.cwd, '/repo/b');
});

test('search remains a literal argument, filters and pagination are passed to gh', async () => {
  const h = harness();
  h.pending[0].resolve(result(repo)); await settle();
  h.pending[1].resolve(result([])); await settle();
  h.view.query = '$(touch /tmp/never) "quoted"'; h.view.state = 'closed'; h.view.limit = 100;
  h.view.refresh(h.cx); h.pending[2].resolve(result(repo)); await settle();
  const request = h.pending[3];
  assert.equal(request.command, 'gh');
  assert.equal(request.args.at(-1), h.view.query);
  assert.equal(request.args[request.args.indexOf('--state') + 1], 'closed');
  assert.equal(request.args[request.args.indexOf('--limit') + 1], '100');
  request.resolve(result([])); await settle();
  assert.equal(h.view.loading, false);
});

test('authentication failures remain errors, not empty successful lists', async () => {
  const h = harness();
  h.pending[0].resolve({ code: 1, stdout: '', stderr: 'Run gh auth login' }); await settle();
  assert.match(h.view.error, /gh auth login/);
  assert.equal(h.view.loading, false);
});

test('launch uses pinned space and cwd, a literal task, and prevents double submission', () => {
  const h = harness(), v = h.view;
  v.target = { space: 'space-a', cwd: '/repo/a' }; v.repo = repo;
  v.issue = { number: 12, title: 'A "title"', body: 'Literal $(shell) body', url: repo.url + '/issues/12' };
  h.setCwd('/repo/b');
  const agent = { key: 'codex', run: ['codex'] };
  v.start(agent, h.cx); v.start(agent, h.cx);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, 'tab.new');
  assert.equal(h.calls[0].args.folder, '/repo/a');
  assert.equal(h.calls[0].args.space, 'space-a');
  assert.ok(h.calls[0].args.argv.includes('--no-daemon'));
  assert.match(h.calls[0].args.task, /Literal \$\(shell\) body/);
  assert.match(h.calls[0].args.task, /owner\/a/);
  assert.equal(h.overlays[0], 'reader');
});

test('Codex flag is not duplicated; other agent arguments are preserved', () => {
  const { api } = harness();
  assert.equal(api.agentArgv({ key: 'codex', run: ['codex', '--no-daemon'] }).length, 2);
  assert.equal(JSON.stringify(api.agentArgv({ key: 'claude', run: ['claude'] })), '["claude"]');
});

test('closed target space prevents launching an agent', () => {
  const h = harness();
  h.view.issue = { number: 1 }; h.view.target = { space: 'closed-space' };
  h.view.start({ key: 'codex', run: ['codex'] }, h.cx);
  assert.equal(h.calls.length, 0);
  assert.match(h.view.agentError, /closed/);
});

const pull = (number, state = 'OPEN') => ({ __typename: 'PullRequest', number, state, title: 'PR', url: `https://github.com/owner/a/pull/${number}`, isDraft: false });
test('PR timeline deduplicates references, removes disconnected links and puts open PRs first', () => {
  const { api } = harness();
  const events = [
    { __typename: 'CrossReferencedEvent', source: pull(9, 'MERGED') },
    { __typename: 'CrossReferencedEvent', source: pull(9, 'MERGED') },
    { __typename: 'ConnectedEvent', subject: pull(2) },
    { __typename: 'ConnectedEvent', subject: pull(4) },
    { __typename: 'DisconnectedEvent', subject: pull(4) },
    { __typename: 'CrossReferencedEvent', source: { __typename: 'Issue', number: 3 } },
  ];
  assert.equal(JSON.stringify(api.pullRequestsFromEvents(events).map(pr => pr.number)), '[2,9]');
});

test('PR icons distinguish open, merged, closed and draft; merged wins over draft', () => {
  const { api } = harness();
  assert.equal(api.prIcon(pull(1)).name, 'git-pull-request');
  assert.equal(api.prIcon(pull(1, 'MERGED')).name, 'git-merge');
  assert.equal(api.prIcon(pull(1, 'CLOSED')).name, 'git-pull-request-closed');
  assert.equal(api.prIcon({ ...pull(1), isDraft: true }).name, 'git-pull-request-draft');
  assert.equal(api.prState({ ...pull(1, 'MERGED'), isDraft: true }), 'Merged');
});

test('PR lookup follows timeline pagination and preserves issue associations', async () => {
  const h = harness();
  const operation = h.view.loadPullRequests([{ id: 'I_1', number: 1 }, { id: 'I_2', number: 2 }], repo, { cwd: '/repo/a' });
  const timeline = (number, more) => ({ timelineItems: {
    nodes: [{ __typename: 'CrossReferencedEvent', source: pull(number) }],
    pageInfo: { hasNextPage: more, endCursor: more ? 'next-page' : null },
  } });
  h.pending[1].resolve(result({ data: { i0: timeline(10, true), i1: timeline(20, false) } }));
  await settle();
  assert.match(h.pending[2].args.at(-1), /after:"next-page"/);
  assert.doesNotMatch(h.pending[2].args.at(-1), /I_2/);
  h.pending[2].resolve(result({ data: { i0: timeline(11, false) } }));
  const prs = await operation;
  assert.equal(JSON.stringify(prs.get(1).map(pr => pr.number)), '[11,10]');
  assert.equal(JSON.stringify(prs.get(2).map(pr => pr.number)), '[20]');
});

test('GraphQL errors do not silently become an empty PR list', async () => {
  const h = harness();
  const operation = h.view.loadPullRequests([{ id: 'I_1', number: 1 }], repo, { cwd: '/repo/a' });
  const rejected = assert.rejects(operation, /permission denied/);
  h.pending[1].resolve(result({ errors: [{ message: 'permission denied' }] }));
  await rejected;
});


test('Codex presets replace conflicting permission flags and preserve model options', () => {
  const { api } = harness();
  const agent = {key:'codex',run:['codex','--yolo','--full-auto','--approve-for-me',
    '-s=danger-full-access','-anever','-c','approval_policy="never"',
    '--config=sandbox_mode="danger-full-access"','-capprovals_reviewer="auto_review"',
    '--model','example-model','-c','model_reasoning_effort="high"']};
  const args=Array.from(api.agentArgv(agent,'workspace'));
  assert.deepEqual(args,['codex','--model','example-model','-c','model_reasoning_effort="high"',
    '--sandbox','workspace-write','--ask-for-approval','on-request','--no-daemon']);
  assert.ok(api.agentArgv(agent).includes('--yolo'));
  assert.deepEqual(Array.from(api.agentArgv({key:'codex',run:['codex','--yolo']},'read-only')),
    ['codex','--sandbox','read-only','--ask-for-approval','never','--no-daemon']);
});

test('Claude and Antigravity replace bypass flags when switching to plan or edits', () => {
  const { api }=harness();
  assert.deepEqual(Array.from(api.agentArgv({run:['claude','--dangerously-skip-permissions','--permission-mode=bypassPermissions','--model','sonnet']},'plan')),
    ['claude','--model','sonnet','--permission-mode','plan']);
  assert.deepEqual(Array.from(api.agentArgv({run:['/Applications/Gemini.app/Contents/Helpers/agy','--mode','plan','--dangerously-skip-permissions','--sandbox']},'edits')),
    ['/Applications/Gemini.app/Contents/Helpers/agy','--sandbox','--mode','accept-edits']);
});

test('presets are unavailable for unknown CLIs, wrappers and noninteractive commands', () => {
  const { api }=harness();
  for (const run of [['opencode'],['sh','-c','codex --yolo'],['codex','exec']]) {
    assert.equal(api.launchModes({run}).length,1);
    assert.throws(()=>api.agentArgv({run},'yolo'),/unavailable/);
  }
});

test('options are inserted before the end-of-options marker', () => {
  const { api }=harness();
  assert.deepEqual(Array.from(api.agentArgv({run:['codex','--','literal --yolo prompt']},'workspace')),
    ['codex','--sandbox','workspace-write','--ask-for-approval','on-request','--no-daemon','--','literal --yolo prompt']);
});

test('selecting another agent resets permissions without starting work or losing extra instructions', () => {
  const h=harness();
  h.view.launchMode='yolo';h.view.selectedAgent={key:'codex'};
  h.view.extraPrompt={value:()=> 'Keep the public API stable.'};
  h.view.selectAgent({key:'claude',run:['claude']},h.cx);
  assert.equal(h.view.launchMode,'default');
  assert.equal(h.view.extraPrompt.value(),'Keep the public API stable.');
  assert.equal(h.calls.length,0);
});

test('additional prompt is passed literally with issue and selected permissions', () => {
  const h=harness(),v=h.view;
  v.target={space:'space-a',cwd:'/repo/a'};v.repo=repo;
  v.issue={number:12,title:'Example',body:'Issue description',url:repo.url+'/issues/12'};
  v.launchMode='workspace';v.extraPrompt={value:()=> 'Keep compatibility.\nDo not execute $(this) as shell text.'};
  v.start({key:'codex',run:['codex']},h.cx);
  const {task,argv}=h.calls[0].args;
  assert.match(task,/Issue description/);
  assert.ok(task.endsWith('Additional instructions from the user:\nKeep compatibility.\nDo not execute $(this) as shell text.'));
  assert.ok(argv.includes('workspace-write'));
  assert.ok(!argv.some(arg=>arg.includes('Keep compatibility')));
});

test('planning launch requests investigation, and invalid mode cannot start a tab', () => {
  const h=harness(),v=h.view;
  v.target={space:'space-a',cwd:'/repo/a'};v.repo=repo;v.issue={number:1,title:'Example'};
  const task=h.api.issueTask(v.issue,'owner/a','Check regressions','plan');
  assert.match(task,/Investigate the issue and propose a plan/);
  assert.doesNotMatch(task,/Implement the solution/);
  v.launchMode='not-a-mode';v.start({run:['codex']},h.cx);
  assert.equal(h.calls.length,0);
  assert.match(v.agentError,/unavailable/);
});

test('reader opens launch settings pinned to its issue, without starting an agent', () => {
  const h=harness(),v=h.view;
  v.detail=true;v.launchOnly=false;v.target={space:'space-a',cwd:'/repo/a'};v.repo=repo;
  v.issue={number:42,title:'Pinned issue'};h.setCwd('/repo/b');
  v.chooseAgent(h.cx);
  assert.equal(h.calls.length,0);
  assert.equal(h.opened.length,1);
  assert.equal(h.opened[0].props.launchOnly,true);
  assert.equal(h.opened[0].props.issue.number,42);
  assert.equal(h.opened[0].props.target.cwd,'/repo/a');
});

test('launch shortcut shares Start readiness and submits the selected mode and literal prompt once', () => {
  const h=harness(),v=h.view;
  v.loading=false;v.issue={number:42,title:'Task',url:repo.url+'/issues/42'};
  v.target={space:'space-a',cwd:'/repo/a'};v.repo=repo;
  v.selectedAgent={key:'codex',run:['codex']};v.launchMode='workspace';
  v.extraPrompt={value:()=> 'First line\nSecond line'};
  for (const flag of ['loading','checking','error','agentError','started']) {
    v[flag]=true;v.submitLaunch(h.cx);v[flag]=false;
    assert.equal(h.calls.length,0,flag);
  }
  const agent=v.selectedAgent;v.selectedAgent=null;v.submitLaunch(h.cx);v.selectedAgent=agent;
  assert.equal(h.calls.length,0);
  v.submitLaunch(h.cx);v.submitLaunch(h.cx);
  assert.equal(h.calls.length,1);
  assert.ok(h.calls[0].args.argv.includes('workspace-write'));
  assert.ok(h.calls[0].args.task.endsWith('First line\nSecond line'));
});


const installedCodex = {key:'codex',name:'Codex',installed:true,run:['codex']};
const installedClaude = {key:'claude',name:'Claude',installed:true,run:['claude']};
const savedDefaults = {agent:'claude',mode:'plan',prompt:'Keep scope narrow.\nRun tests.'};
const launchProps = {number:42,launchOnly:true,issue:{number:42,title:'Task',url:repo.url+'/issues/42'},repo,target:{space:'space-a',cwd:'/repo/a'}};

test('new launches inherit persisted defaults without writing them and use scoped Command Enter bindings', async () => {
  const h=harness({props:launchProps, defaults:savedDefaults,choices:[installedCodex,installedClaude]});
  await settle();
  assert.equal(h.view.selectedAgent.key,'claude');assert.equal(h.view.launchMode,'plan');
  assert.equal(h.view.extraPrompt.value(),savedDefaults.prompt);
  assert.equal(h.bindings.length,2);
  assert.ok(h.bindings.every(b=>b.keystroke==='cmd-enter' && b.action==='github_issue_start'));
  assert.deepEqual(h.bindings.map(b=>b.context),['GithubIssueLauncher','GithubIssueLauncher > Input']);
  h.view.extraPrompt.set_value('One task only');h.view.selectAgent(installedCodex,h.cx);
  h.view.submitLaunch(h.cx);
  assert.equal(h.calls.length,1);assert.ok(h.calls[0].args.task.endsWith('One task only'));
  assert.equal(h.writes.length,0);assert.equal(h.store.get('github-issues.launch-defaults.v1').prompt,savedDefaults.prompt);
});

test('settings edits and reset remain drafts until Save; saving never starts an agent or reads GitHub', async () => {
  const h=harness({props:{settingsOnly:true,target:launchProps.target},defaults:savedDefaults,choices:[installedCodex,installedClaude]});
  await settle();
  h.view.resetDefaults(h.cx);
  assert.equal(h.view.launchMode,'default');assert.equal(h.view.extraPrompt.value(),'');
  assert.equal(h.writes.length,0);assert.equal(h.overlays.length,0);
  h.view.selectAgent(installedCodex,h.cx);h.view.launchMode='yolo';h.view.extraPrompt.set_value('Saved instructions');
  h.view.submitLaunch(h.cx);h.view.submitLaunch(h.cx);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].value.agent,'codex');
  assert.equal(h.writes[0].value.mode,'yolo');assert.equal(h.writes[0].value.prompt,'Saved instructions');
  assert.equal(h.calls.length,0);assert.equal(h.pending.length,0);assert.equal(h.overlays.length,1);
});

test('missing agent, unsupported permissions and corrupt defaults cannot transfer saved YOLO to a fallback', () => {
  const {api}=harness();
  const missing=api.defaultSelection([installedClaude],{agent:'codex',mode:'yolo'});
  assert.equal(missing.agent.key,'claude');assert.equal(missing.mode,'default');assert.match(missing.notice,/unavailable/);
  const unsupported=api.defaultSelection([installedClaude],{agent:'claude',mode:'workspace'});
  assert.equal(unsupported.mode,'default');assert.match(unsupported.notice,/permissions/);
  const empty=api.defaultSelection([],{agent:'codex',mode:'yolo'});
  assert.equal(empty.agent,null);assert.equal(empty.mode,'default');
  for(const value of [null,42,'invalid',{agent:42,mode:{},prompt:[]}]) {
    const valid=api.launchDefaults(value);
    assert.equal(valid.agent,null);assert.equal(valid.mode,'default');assert.equal(valid.prompt,'');
  }
});

test('settings cannot save during discovery, without an agent, or with an invalid permission mode', async () => {
  const h=harness({props:{settingsOnly:true,target:launchProps.target},choices:[installedCodex]});
  h.view.submitLaunch(h.cx);assert.equal(h.writes.length,0);
  await settle();h.view.launchMode='invalid';h.view.submitLaunch(h.cx);
  assert.equal(h.writes.length,0);assert.match(h.view.agentError,/unavailable/);
  const empty=harness({props:{settingsOnly:true,target:launchProps.target}});
  await settle();empty.view.submitLaunch(empty.cx);assert.equal(empty.writes.length,0);
});


test('clearing the search field restores issues and discards an older empty search response', async () => {
  const h=harness(),v=h.view;v.loadPullRequests=async()=>new Map();
  h.pending[0].resolve(result(repo));await settle();h.pending[1].resolve(result([]));await settle();
  v.input.set_value('no-match');v.input.emit('submit',h.cx);
  h.pending[2].resolve(result(repo));await settle();
  assert.ok(h.pending[3].args.includes('--search'));
  v.input.set_value('');v.input.emit('change',h.cx);
  assert.equal(v.query,'');
  assert.equal(h.pending.length,5);
  h.pending[4].resolve(result(repo));await settle();
  assert.ok(!h.pending[5].args.includes('--search'));
  h.pending[5].resolve(result([{number:42,title:'Visible again'}]));await settle();
  h.pending[3].resolve(result([]));await settle();
  assert.equal(v.items[0].number,42);assert.equal(v.loading,false);
});

test('state filters use the visible search draft, not the previous submitted query', async () => {
  const h=harness(),v=h.view;
  v.query='old-search';v.input.set_value('  label:bug  ');
  v.applyFilters('closed',h.cx);
  h.pending[1].resolve(result(repo));await settle();
  const args=h.pending[2].args;
  assert.equal(args[args.indexOf('--state')+1],'closed');
  assert.equal(args[args.indexOf('--search')+1],'label:bug');
});

test('Clear search resets both field and applied query while preserving state', async () => {
  const h=harness(),v=h.view;
  v.state='all';v.limit=100;v.query='old-search';v.input.set_value('new draft');
  v.clearSearch(h.cx);
  assert.equal(v.input.value(),'');assert.equal(v.query,'');assert.equal(v.limit,50);
  h.pending[1].resolve(result(repo));await settle();
  const args=h.pending[2].args;
  assert.equal(args[args.indexOf('--state')+1],'all');assert.ok(!args.includes('--search'));
});
