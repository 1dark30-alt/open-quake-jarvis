'use strict';

function text(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function iso(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function positiveInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function boundedText(value, limit, fallback = '') { return text(value, fallback).slice(0, limit); }

function issueLabel(value) {
  value = value && typeof value === 'object' ? value : {};
  const color = /^[0-9a-f]{6}$/i.test(value.color || '') ? value.color.toLowerCase() : '6e7781';
  const channels = [0, 2, 4].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return {
    name: boundedText(value.name, 100, 'label'),
    color,
    foreground: whiteContrast >= blackContrast ? '#ffffff' : '#000000',
  };
}

function issueUrl(repositoryUrl, number) {
  try {
    const parsed = new URL(String(repositoryUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    if (parsed.pathname.split('/').filter(Boolean).length !== 2) return '';
    return parsed.origin + parsed.pathname.replace(/\/$/, '') + '/issues/' + number;
  } catch (error) { return ''; }
}

function issueSummary(issueValue, repositoryUrl) {
  const value = issueValue && typeof issueValue === 'object' ? issueValue : {};
  if (value.pull_request) return null;
  const number = positiveInteger(value.number);
  if (!number) return null;
  const state = value.state === 'closed' ? 'closed' : 'open';
  return {
    number,
    title: boundedText(value.title, 300, 'Untitled issue'),
    state,
    stateReason: boundedText(value.state_reason, 40),
    author: boundedText(value.user && value.user.login, 100, 'unknown'),
    labels: (Array.isArray(value.labels) ? value.labels : []).slice(0, 20).map(issueLabel),
    assignees: (Array.isArray(value.assignees) ? value.assignees : []).slice(0, 20)
      .map(item => boundedText(item && item.login, 100)).filter(Boolean),
    comments: Math.max(0, Math.floor(Number(value.comments) || 0)),
    createdAt: iso(value.created_at),
    updatedAt: iso(value.updated_at),
    closedAt: iso(value.closed_at),
    url: issueUrl(repositoryUrl, number),
  };
}

function issueDetail(issueValue, repositoryUrl) {
  const mapped = issueSummary(issueValue, repositoryUrl);
  if (!mapped) return null;
  const value = issueValue && typeof issueValue === 'object' ? issueValue : {};
  mapped.body = boundedText(value.body_text || value.body, 12000);
  mapped.milestone = value.milestone && typeof value.milestone === 'object'
    ? { number: positiveInteger(value.milestone.number), title: boundedText(value.milestone.title, 200, 'Milestone') } : null;
  return mapped;
}

function issuePage(values, repositoryUrl) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(value => issueSummary(value, repositoryUrl)).filter(value => {
    if (!value || seen.has(value.number)) return false;
    seen.add(value.number);
    return true;
  });
}

function status(statusValue, conclusionValue) {
  const current = text(statusValue).toLowerCase();
  const conclusion = text(conclusionValue).toLowerCase();
  if (current && current !== 'completed') {
    const label = current === 'in_progress' ? 'Running' : current.replace(/_/g, ' ');
    return { key: 'running', label };
  }
  if (conclusion === 'success') return { key: 'success', label: 'Success' };
  if (['failure', 'timed_out', 'startup_failure', 'action_required'].includes(conclusion)) return { key: 'failure', label: conclusion.replace(/_/g, ' ') };
  if (conclusion === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
  if (['neutral', 'skipped', 'stale'].includes(conclusion)) return { key: 'neutral', label: conclusion };
  return { key: 'unknown', label: conclusion || current || 'Unknown' };
}

function durationMs(startedAt, completedAt, now = Date.now()) {
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(completedAt || '');
  return Math.max(0, (Number.isFinite(end) ? end : Number(now)) - start);
}

function pull(pullValue) {
  const value = pullValue && typeof pullValue === 'object' ? pullValue : {};
  const requestedReviewers = Array.isArray(value.requested_reviewers) ? value.requested_reviewers : [];
  const requestedTeams = Array.isArray(value.requested_teams) ? value.requested_teams : [];
  return {
    number: positiveInteger(value.number), title: text(value.title, 'Untitled pull request'), state: text(value.state, 'open'), draft: !!value.draft,
    author: text(value.user && value.user.login, 'unknown'), url: text(value.html_url), updatedAt: iso(value.updated_at),
    comments: Math.max(0, Number(value.comments) || 0), reviewComments: Math.max(0, Number(value.review_comments) || 0),
    headRef: text(value.head && value.head.ref), baseRef: text(value.base && value.base.ref), headSha: text(value.head && value.head.sha),
    additions: Math.max(0, Number(value.additions) || 0), deletions: Math.max(0, Number(value.deletions) || 0),
    changedFiles: Math.max(0, Number(value.changed_files) || 0), commits: Math.max(0, Number(value.commits) || 0),
    mergeable: typeof value.mergeable === 'boolean' ? value.mergeable : null, mergeableState: text(value.mergeable_state),
    requestedReviewers: requestedReviewers.map(item => text(item && item.login)).filter(Boolean),
    requestedTeams: requestedTeams.map(item => text(item && (item.name || item.slug))).filter(Boolean),
  };
}

function reviewSummary(reviews, requestedReviewers, requestedTeams) {
  const latest = new Map();
  (Array.isArray(reviews) ? reviews : []).forEach(review => {
    const login = text(review && review.user && review.user.login);
    const state = text(review && review.state).toUpperCase();
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(state)) return;
    const at = Date.parse(review.submitted_at || '') || 0;
    const old = latest.get(login);
    if (!old || at >= old.at) latest.set(login, { login, state, at });
  });
  const current = Array.from(latest.values()).filter(value => value.state !== 'DISMISSED');
  const states = current.map(value => value.state);
  const requested = (Array.isArray(requestedReviewers) ? requestedReviewers : []).map(value => typeof value === 'string' ? value : text(value && value.login)).filter(Boolean)
    .concat((Array.isArray(requestedTeams) ? requestedTeams : []).map(value => typeof value === 'string' ? value : text(value && (value.name || value.slug))).filter(Boolean));
  const state = states.includes('CHANGES_REQUESTED') ? 'changes_requested'
    : requested.length ? 'review_requested'
      : states.includes('APPROVED') ? 'approved' : 'pending';
  return {
    state,
    approved: states.filter(value => value === 'APPROVED').length,
    changesRequested: states.filter(value => value === 'CHANGES_REQUESTED').length,
    reviewers: current.length,
    requested: requested.length,
    items: current.map(value => ({ reviewer: value.login, state: value.state.toLowerCase() }))
      .concat(requested.map(reviewer => ({ reviewer, state: 'review_requested' }))),
  };
}

function workflowRunMap(workflowRuns, now) {
  const bySuite = new Map();
  (Array.isArray(workflowRuns && workflowRuns.workflow_runs) ? workflowRuns.workflow_runs : []).forEach(value => {
    const suiteId = positiveInteger(value && value.check_suite_id);
    if (suiteId) bySuite.set(suiteId, run(value, now));
  });
  return bySuite;
}

function checkDetails(checks, statuses, workflowRuns, now = Date.now()) {
  const bySuite = workflowRunMap(workflowRuns, now);
  const items = [];
  (Array.isArray(checks && checks.check_runs) ? checks.check_runs : []).forEach(value => {
    value = value && typeof value === 'object' ? value : {};
    const suiteId = positiveInteger(value.check_suite && value.check_suite.id);
    const linkedRun = suiteId && bySuite.get(suiteId) || null;
    items.push({
      id: positiveInteger(value.id), type: 'check', name: text(value.name, 'Check'), status: status(value.status, value.conclusion),
      app: text(value.app && value.app.name), url: text(value.details_url), suiteId,
      runId: linkedRun && linkedRun.id || null, runNumber: linkedRun && linkedRun.runNumber || null,
      runUrl: linkedRun && linkedRun.url || '', jobId: positiveInteger(value.id),
      startedAt: iso(value.started_at), completedAt: iso(value.completed_at), durationMs: durationMs(value.started_at, value.completed_at, now),
    });
  });
  (Array.isArray(statuses && statuses.statuses) ? statuses.statuses : []).forEach(value => {
    value = value && typeof value === 'object' ? value : {};
    const state = text(value.state).toLowerCase();
    const mapped = state === 'success' ? status('completed', 'success')
      : ['failure', 'error'].includes(state) ? status('completed', 'failure')
        : state === 'pending' ? status('pending', null) : status('', state);
    items.push({
      id: positiveInteger(value.id), type: 'status', name: text(value.context, 'Commit status'), status: mapped,
      app: text(value.creator && value.creator.login), url: text(value.target_url), suiteId: null, runId: null, runNumber: null,
      runUrl: '', jobId: null, startedAt: iso(value.created_at), completedAt: iso(value.updated_at), durationMs: null,
    });
  });
  const priority = { failure: 0, running: 1, unknown: 2, cancelled: 3, neutral: 4, success: 5 };
  items.sort((a, b) => (priority[a.status.key] ?? 9) - (priority[b.status.key] ?? 9) || a.name.localeCompare(b.name));
  return {
    total: items.length,
    success: items.filter(value => value.status.key === 'success').length,
    failed: items.filter(value => value.status.key === 'failure').length,
    pending: items.filter(value => value.status.key === 'running').length,
    items,
  };
}

function checkSummary(checks, statuses) {
  const value = checkDetails(checks, statuses, null);
  return { total: value.total, success: value.success, failed: value.failed, pending: value.pending };
}

function pullDetails(pullValue, reviews, checks, statuses, workflowRuns, now = Date.now()) {
  const mapped = pull(pullValue);
  mapped.review = reviewSummary(reviews, mapped.requestedReviewers, mapped.requestedTeams);
  mapped.checks = checkDetails(checks, statuses, workflowRuns, now);
  mapped.reviewCount = Array.isArray(reviews) ? reviews.length : 0;
  return mapped;
}

function workflow(value, lastRunValue, now = Date.now()) {
  value = value && typeof value === 'object' ? value : {};
  return {
    id: positiveInteger(value.id), name: text(value.name, 'Workflow'), path: text(value.path), state: text(value.state), url: text(value.html_url),
    lastRun: lastRunValue ? run(lastRunValue, now) : null,
  };
}

function run(value, now = Date.now()) {
  value = value && typeof value === 'object' ? value : {};
  const name = text(value.name, 'Workflow');
  return {
    id: positiveInteger(value.id), workflowId: positiveInteger(value.workflow_id), runNumber: positiveInteger(value.run_number), runAttempt: positiveInteger(value.run_attempt),
    name, workflowName: name, displayTitle: text(value.display_title), branch: text(value.head_branch), headSha: text(value.head_sha),
    commitMessage: text(value.head_commit && value.head_commit.message).split('\n')[0], event: text(value.event), actor: text(value.actor && value.actor.login), url: text(value.html_url),
    status: status(value.status, value.conclusion), createdAt: iso(value.created_at), startedAt: iso(value.run_started_at || value.created_at), updatedAt: iso(value.updated_at),
    durationMs: durationMs(value.run_started_at || value.created_at, value.updated_at, now),
  };
}

function artifact(value) {
  value = value && typeof value === 'object' ? value : {};
  return {
    id: positiveInteger(value.id), name: text(value.name, 'Artifact'), sizeBytes: Math.max(0, Number(value.size_in_bytes) || 0),
    expired: !!value.expired, createdAt: iso(value.created_at), expiresAt: iso(value.expires_at),
  };
}

function runControls(value) {
  const key = value && value.status && value.status.key || 'unknown';
  return { cancel: key === 'running', rerun: key !== 'running' && key !== 'unknown', rerunFailed: key === 'failure' };
}

function runDetails(runValue, jobsValue, artifactsValue, now = Date.now()) {
  const mapped = run(runValue, now);
  mapped.jobs = (Array.isArray(jobsValue && jobsValue.jobs) ? jobsValue.jobs : []).map(job => ({
    id: positiveInteger(job && job.id), name: text(job && job.name, 'Job'), status: status(job && job.status, job && job.conclusion),
    startedAt: iso(job && job.started_at), completedAt: iso(job && job.completed_at), durationMs: durationMs(job && job.started_at, job && job.completed_at, now),
    url: text(job && job.html_url),
    steps: (Array.isArray(job && job.steps) ? job.steps : []).map(step => ({
      number: positiveInteger(step && step.number), name: text(step && step.name, 'Step'), status: status(step && step.status, step && step.conclusion),
      startedAt: iso(step && step.started_at), completedAt: iso(step && step.completed_at), durationMs: durationMs(step && step.started_at, step && step.completed_at, now),
    })),
  }));
  mapped.artifacts = (Array.isArray(artifactsValue && artifactsValue.artifacts) ? artifactsValue.artifacts : []).map(artifact);
  const failedJobIndex = mapped.jobs.findIndex(job => job.status.key === 'failure');
  const runningJobIndex = mapped.jobs.findIndex(job => job.status.key === 'running');
  mapped.preferredJobIndex = failedJobIndex >= 0 ? failedJobIndex : runningJobIndex >= 0 ? runningJobIndex : 0;
  const failedJob = failedJobIndex >= 0 ? mapped.jobs[failedJobIndex] : null;
  const failedStep = failedJob && failedJob.steps.find(step => step.status.key === 'failure') || null;
  const runningJob = runningJobIndex >= 0 ? mapped.jobs[runningJobIndex] : null;
  const runningStep = runningJob && runningJob.steps.find(step => step.status.key === 'running') || null;
  mapped.failure = failedJob ? { jobId: failedJob.id, jobName: failedJob.name, stepName: failedStep && failedStep.name || '' } : null;
  mapped.active = runningJob ? { jobId: runningJob.id, jobName: runningJob.name, stepName: runningStep && runningStep.name || '' } : null;
  mapped.controls = runControls(mapped);
  return mapped;
}

function overview(repo, commit, release, tag, comparison, pullsValue, runsValue, associatedPulls, now = Date.now()) {
  const pulls = (Array.isArray(pullsValue) ? pullsValue : []).map(value => value && value.review && value.checks ? value : pull(value));
  const indicatorCount = pulls.filter(value => value.review || value.checks).length;
  const runs = (Array.isArray(runsValue && runsValue.workflow_runs) ? runsValue.workflow_runs : []).map(value => run(value, now));
  const commitPull = (Array.isArray(associatedPulls) ? associatedPulls : []).map(pull).find(value => value.number) || null;
  return {
    repository: {
      fullName: text(repo && repo.full_name), private: !!(repo && repo.private), fork: !!(repo && repo.fork),
      defaultBranch: text(repo && repo.default_branch), url: text(repo && repo.html_url),
      parent: repo && repo.parent ? { fullName: text(repo.parent.full_name), defaultBranch: text(repo.parent.default_branch), url: text(repo.parent.html_url) } : null,
      source: repo && repo.source ? { fullName: text(repo.source.full_name), defaultBranch: text(repo.source.default_branch), url: text(repo.source.html_url) } : null,
    },
    commit: {
      sha: text(commit && commit.sha).slice(0, 7), fullSha: text(commit && commit.sha),
      message: text(commit && commit.commit && commit.commit.message).split('\n')[0], fullMessage: text(commit && commit.commit && commit.commit.message),
      author: text(commit && commit.author && commit.author.login) || text(commit && commit.commit && commit.commit.author && commit.commit.author.name, 'unknown'),
      date: iso(commit && commit.commit && commit.commit.author && commit.commit.author.date), url: text(commit && commit.html_url),
      associatedPull: commitPull ? { number: commitPull.number, title: commitPull.title, url: commitPull.url } : null,
    },
    release: release ? { tag: text(release.tag_name), name: text(release.name), date: iso(release.published_at), url: text(release.html_url) }
      : tag ? { tag: text(tag.name), name: text(tag.name), date: null, url: '' } : null,
    comparison: comparison ? { ahead: Math.max(0, Number(comparison.ahead_by) || 0), behind: Math.max(0, Number(comparison.behind_by) || 0), status: text(comparison.status) } : null,
    pulls: {
      open: pulls.length,
      drafts: pulls.filter(item => item.draft).length,
      ready: pulls.filter(item => !item.draft).length,
      reviewRequested: pulls.filter(item => item.review && item.review.state === 'review_requested').length,
      failing: pulls.filter(item => item.checks && item.checks.failed > 0).length,
      running: pulls.filter(item => item.checks && item.checks.pending > 0).length,
      attentionSampled: indicatorCount < pulls.length,
      items: pulls.slice(0, 3),
    },
    actions: {
      latest: runs[0] || null,
      running: runs.filter(item => item.status.key === 'running').length,
      failed: runs.filter(item => item.status.key === 'failure').length,
      successful: runs.filter(item => item.status.key === 'success').length,
    },
  };
}

module.exports = {
  artifact, checkDetails, checkSummary, durationMs, issueDetail, issueLabel, issuePage, issueSummary, overview, positiveInteger, pull, pullDetails, reviewSummary,
  run, runControls, runDetails, status, workflow,
};
