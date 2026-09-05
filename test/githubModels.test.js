'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../app/githubModels');

test('GitHub workflow states distinguish running, failure, cancellation, and success', () => {
  assert.equal(models.status('in_progress', null).key, 'running');
  assert.equal(models.status('completed', 'failure').key, 'failure');
  assert.equal(models.status('completed', 'cancelled').key, 'cancelled');
  assert.equal(models.status('completed', 'success').key, 'success');
});

test('review and check summaries combine modern checks with legacy statuses', () => {
  const reviews = models.reviewSummary([
    { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' },
    { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' },
    { user: { login: 'b' }, state: 'APPROVED', submitted_at: '2026-01-02T00:00:00Z' },
  ]);
  assert.equal(reviews.state, 'approved');
  assert.equal(reviews.approved, 2);
  const checks = models.checkSummary({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] }, { statuses: [{ state: 'pending' }] });
  assert.deepEqual(checks, { total: 3, success: 1, failed: 1, pending: 1 });
});

test('overview maps hosted comparison and never invents local clean state', () => {
  const value = models.overview(
    { full_name: 'acme/repo', default_branch: 'main', html_url: 'https://github.com/acme/repo' },
    { sha: 'abcdef012345', commit: { message: 'subject\nbody', author: { name: 'A', date: '2026-01-01T00:00:00Z' } } },
    null, { name: 'v1' }, { ahead_by: 2, behind_by: 3, status: 'diverged' }, [], { workflow_runs: [] }, Date.now(),
  );
  assert.deepEqual(value.comparison, { ahead: 2, behind: 3, status: 'diverged' });
  assert.equal(Object.hasOwn(value.repository, 'clean'), false);
});

test('review summaries expose requested, approved, and changes-requested attention states', () => {
  assert.equal(models.reviewSummary([], [{ login:'reviewer' }], []).state, 'review_requested');
  assert.equal(models.reviewSummary([{ user:{ login:'a' }, state:'APPROVED', submitted_at:'2026-01-01T00:00:00Z' }]).state, 'approved');
  const changed = models.reviewSummary([
    { user:{ login:'a' }, state:'APPROVED', submitted_at:'2026-01-01T00:00:00Z' },
    { user:{ login:'b' }, state:'CHANGES_REQUESTED', submitted_at:'2026-01-02T00:00:00Z' },
  ]);
  assert.equal(changed.state, 'changes_requested');
  assert.equal(changed.changesRequested, 1);
});

test('pull detail maps change counts and prioritises failed checks linked to Actions runs', () => {
  const value = models.pullDetails(
    { number:7, title:'Ship V2', state:'open', user:{login:'dev'}, additions:12, deletions:3, changed_files:4, head:{ref:'feature',sha:'abc'}, base:{ref:'main'} },
    [],
    { check_runs:[
      { id:1, name:'Unit', status:'completed', conclusion:'success', check_suite:{id:10} },
      { id:2, name:'Package', status:'completed', conclusion:'failure', check_suite:{id:11} },
    ] },
    { statuses:[] },
    { workflow_runs:[{ id:99, workflow_id:5, run_number:12, name:'CI', status:'completed', conclusion:'failure', check_suite_id:11, html_url:'https://github.com/acme/repo/actions/runs/99' }] },
    Date.parse('2026-01-03T00:00:00Z'),
  );
  assert.deepEqual({ additions:value.additions, deletions:value.deletions, changedFiles:value.changedFiles }, { additions:12, deletions:3, changedFiles:4 });
  assert.equal(value.checks.items[0].name, 'Package');
  assert.equal(value.checks.items[0].runId, 99);
  assert.equal(value.checks.failed, 1);
});

test('run details map jobs and step durations and select the failed job and step', () => {
  const value = models.runDetails(
    { id:40, workflow_id:5, run_number:9, name:'Build', head_sha:'abcdef123', status:'completed', conclusion:'failure', run_started_at:'2026-01-01T00:00:00Z', updated_at:'2026-01-01T00:01:00Z' },
    { jobs:[
      { id:1, name:'Lint', status:'completed', conclusion:'success', started_at:'2026-01-01T00:00:00Z', completed_at:'2026-01-01T00:00:10Z', steps:[] },
      { id:2, name:'Tests', status:'completed', conclusion:'failure', started_at:'2026-01-01T00:00:10Z', completed_at:'2026-01-01T00:00:30Z', steps:[
        { number:1, name:'npm test', status:'completed', conclusion:'failure', started_at:'2026-01-01T00:00:12Z', completed_at:'2026-01-01T00:00:30Z' },
        { number:2, name:'Package', status:'completed', conclusion:'skipped' },
      ] },
    ] },
    { artifacts:[{ id:3, name:'win-x64', size_in_bytes:1024, expired:false, expires_at:'2026-02-01T00:00:00Z' }] },
    Date.parse('2026-01-01T00:01:00Z'),
  );
  assert.equal(value.preferredJobIndex, 1);
  assert.deepEqual(value.failure, { jobId:2, jobName:'Tests', stepName:'npm test' });
  assert.equal(value.jobs[1].steps[0].durationMs, 18000);
  assert.equal(value.jobs[1].steps[1].status.label, 'skipped');
  assert.deepEqual(value.controls, { cancel:false, rerun:true, rerunFailed:true });
  assert.equal(value.artifacts[0].name, 'win-x64');
});

test('run controls expose only operations valid for success, failure, and running states', () => {
  assert.deepEqual(models.runControls({ status:{key:'success'} }), { cancel:false, rerun:true, rerunFailed:false });
  assert.deepEqual(models.runControls({ status:{key:'failure'} }), { cancel:false, rerun:true, rerunFailed:true });
  assert.deepEqual(models.runControls({ status:{key:'running'} }), { cancel:true, rerun:false, rerunFailed:false });
});

test('partial GitHub responses produce safe empty domain models', () => {
  const detail = models.pullDetails(null, null, null, null, null);
  assert.equal(detail.number, null);
  assert.deepEqual(detail.checks.items, []);
  const run = models.runDetails(null, null, null);
  assert.deepEqual(run.jobs, []);
  assert.deepEqual(run.artifacts, []);
});

test('issue summary and detail map bounded labels, assignees, milestone, and plain text safely', () => {
  const raw = {
    number:42, title:'<img src=x onerror=alert(1)>', state:'open', user:{login:'octocat'},
    labels:[{name:'bug',color:'d73a4a'},{name:'invalid',color:'url(javascript:bad)'}],
    assignees:[{login:'alice'},{login:'bob'}], comments:4,
    created_at:'2026-08-20T10:00:00Z', updated_at:'2026-08-24T10:00:00Z',
    body_text:'<script>alert(1)</script> **plain text**', milestone:{number:3,title:'v0.7.0'},
    html_url:'https://evil.example/issues/42',
  };
  const summary = models.issueSummary(raw, 'https://github.com/acme/repo');
  const detail = models.issueDetail(raw, 'https://github.com/acme/repo');
  assert.equal(summary.url, 'https://github.com/acme/repo/issues/42');
  assert.deepEqual(summary.assignees, ['alice','bob']);
  assert.match(summary.labels[0].foreground, /^#(?:000000|ffffff)$/);
  assert.equal(summary.labels[1].color, '6e7781');
  assert.equal(models.issueLabel({name:'dark',color:'000000'}).foreground, '#ffffff');
  assert.equal(models.issueLabel({name:'light',color:'ffffff'}).foreground, '#000000');
  assert.equal(detail.body, '<script>alert(1)</script> **plain text**');
  assert.deepEqual(detail.milestone, {number:3,title:'v0.7.0'});
});

test('issue pages exclude pull requests represented as issue resources', () => {
  const items = models.issuePage([
    {number:1,title:'Real issue',state:'open'},
    {number:2,title:'Pull request',state:'open',pull_request:{url:'https://api.github.com/repos/acme/repo/pulls/2'}},
    {number:'bad',title:'Malformed'},
  ], 'https://github.com/acme/repo');
  assert.deepEqual(items.map(item => item.number), [1]);
});

test('issue detail tolerates missing optional metadata and rejects unsafe repository URLs', () => {
  const detail = models.issueDetail({number:7,title:'Minimal'}, 'https://evil.example/acme/repo');
  assert.deepEqual(detail.labels, []);
  assert.deepEqual(detail.assignees, []);
  assert.equal(detail.milestone, null);
  assert.equal(detail.body, '');
  assert.equal(detail.url, '');
});
