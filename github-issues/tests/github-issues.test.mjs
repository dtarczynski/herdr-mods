import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise the real mod's async boundaries and launch payload without starting agents.
const source = readFileSync(new URL('../mods/github-issues/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ')
  .replace('export default class GithubIssues', 'class GithubIssues')
  + '\nglobalThis.api = { GithubIssues, agentArgv, issueTask, pullRequestsFromEvents, prState, prIcon };';
function harness() {
  let cwd = '/repo/a';
  const calls = [], pending = [], jobs = [], overlays = [];
  const input = () => ({ value: () => '', set_value() {}, on() {} });
  const scope = {
    View: class {}, InputState: { new: input },
    props: () => ({ overlay: 'reader' }),
    spaces: () => [{ id: 'space-a', active: true, folder: cwd }],
    focused: () => ({ pane: 'pane-a', cwd }), panes: () => [{ pane: 'pane-a', cwd }],
    exec: (command, args, options) => new Promise(resolve => pending.push({ command, args, options, resolve })),
    nextCommand: () => new Promise(() => {}),
    run: (name, args) => calls.push({ name, args }), closeOverlay: id => overlays.push(id),
  };
  vm.createContext(scope); vm.runInContext(source, scope);
  const cx = { notify() {}, timer: { every() {} }, spawn(fn) { jobs.push(fn(cx)); } };
  const view = new scope.api.GithubIssues();
  view.init({}, cx);
  return { view, cx, calls, pending, jobs, overlays, api: scope.api, setCwd(value) { cwd = value; } };
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
