import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { compileFunction, constants } from 'node:vm';
import runGate, {
  CODEX_BOT_ID,
  ACTIONS_BOT_ID,
  completedReview,
  reviewDecision,
  parseBranches,
  parseReviewTimeoutMinutes,
} from '../src/gate.mjs';

const HEAD = '2db9380083cb439a58d3e9b0b9631bbfb50394e4';
const OTHER_HEAD = 'aa59380083cb439a58d3e9b0b9631bbfb50394e4';
const COMPLETED_AT = '2026-09-14T21:09:46.383544Z';
const ROW = `| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${COMPLETED_AT}">${COMPLETED_AT}</relative-time> | \`2db9380\` | PR opened |`;
const BODY = `<!-- codex-pull-request-review-summary -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
${ROW}
`;
const BOT = { id: CODEX_BOT_ID, login: 'chatgpt-codex-connector[bot]' };
const SUMMARY = {
  node_id: 'summary-node',
  user: BOT,
  body: BODY,
  html_url: 'https://github.com/example/game/pull/3#issuecomment-1',
};
const THUMB = {
  user: { ...BOT, type: 'User' },
  content: '+1',
  created_at: '2026-09-14T21:09:49Z',
};
const REVIEW = {
  user: BOT,
  commit_id: HEAD,
  state: 'COMMENTED',
  submitted_at: '2026-09-14T21:09:47Z',
};
const PULL = { state: 'open', base: { ref: 'dev' }, head: { sha: HEAD } };
const REVIEW_REQUEST = { id: 91, user: { id: 123 }, body: '@codex review' };

function setup({
  comments = [SUMMARY],
  reviews = [],
  reactions = [THUMB],
  commentReactions = [],
  openPulls = [],
  protectedBranches = ['dev', 'main'],
  reviewTimeoutMinutes = 0,
  now = Date.now,
  sleep,
  statusHistory = [],
} = {}) {
  const api = {
    openPulls: vi.fn().mockResolvedValue(openPulls),
    timeline: vi.fn().mockResolvedValue([]),
    comments: vi.fn().mockResolvedValue(comments),
    reviews: vi.fn().mockResolvedValue(reviews),
    reactions: vi.fn().mockResolvedValue(reactions),
    commentReactions: vi.fn().mockResolvedValue(commentReactions),
    commit: vi.fn().mockResolvedValue({ data: { sha: HEAD } }),
    pull: vi.fn().mockResolvedValue({ data: PULL }),
    statuses: vi
      .fn()
      .mockImplementation(({ ref }) =>
        Promise.resolve(statusHistory.filter((status) => status.sha === ref)),
      ),
    status: vi.fn().mockImplementation((status) => {
      const data = {
        ...status,
        creator: { id: ACTIONS_BOT_ID },
        created_at: new Date(now()).toISOString(),
      };
      statusHistory.push(data);
      return Promise.resolve({ data });
    }),
  };
  const github = {
    paginate: vi.fn((method, options) => method(options)),
    graphql: vi.fn().mockResolvedValue({ node: { editor: { databaseId: CODEX_BOT_ID } } }),
    rest: {
      issues: { listComments: api.comments, listEventsForTimeline: api.timeline },
      pulls: { list: api.openPulls, listReviews: api.reviews, get: api.pull },
      reactions: { listForIssue: api.reactions, listForIssueComment: api.commentReactions },
      repos: {
        getCommit: api.commit,
        createCommitStatus: api.status,
        listCommitStatusesForRef: api.statuses,
      },
    },
  };
  const context = {
    repo: { owner: 'example', repo: 'game' },
    payload: { pull_request: { number: 3 } },
    serverUrl: 'https://github.com',
    runId: 123,
  };
  return {
    api,
    github,
    context,
    decision: () =>
      reviewDecision({ github, ...context.repo, number: 3, headSha: HEAD, protectedBranches }),
    run: () =>
      runGate({
        github,
        context,
        core: { info: vi.fn() },
        protectedBranches,
        reviewTimeoutMinutes,
        now,
        sleep,
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Codex summary format', () => {
  it('reads the observed completed-review summary and its reviewed commit', () => {
    expect(completedReview(BODY)).toEqual({
      commit: '2db9380',
      completedAt: Date.parse(COMPLETED_AT),
    });
  });

  it.each([
    ['running', BODY.replace('✅ **Completed**', '🔄 **Running** since')],
    ['failed', BODY.replace('✅ **Completed**', '❌ **Failed**')],
    ['unknown format', BODY.replace('✅ **Completed**', 'Done')],
    ['missing marker', BODY.replace('<!-- codex-pull-request-review-summary -->', '')],
    ['invalid timestamp', BODY.replaceAll(COMPLETED_AT, 'not-a-time')],
    ['invalid commit', BODY.replace('`2db9380`', '`refs/heads/dev`')],
    ['duplicate review rows', `${BODY}\n${ROW}`],
    ['competing running row', `${BODY}\n${ROW.replace('✅ **Completed**', '🔄 **Running**')}`],
    ['empty content', undefined],
  ])('does not interpret %s as review completion', (_name, body) => {
    expect(completedReview(body)).toBeNull();
  });
});

describe('review evidence', () => {
  it.each(['dev', 'main'])(
    'blocks a duplicate open PR using this commit against %s',
    async (base) => {
      const fixture = setup({ openPulls: [{ ...PULL, number: 4, base: { ref: base } }] });
      expect(await fixture.decision()).toMatchObject({
        state: 'pending',
        description: expect.stringContaining('Another open PR'),
      });
    },
  );

  it.each([
    ['the current PR', { ...PULL, number: 3 }],
    ['another commit', { ...PULL, number: 4, head: { sha: OTHER_HEAD } }],
    ['an unprotected target', { ...PULL, number: 4, base: { ref: 'experiment' } }],
  ])('does not confuse %s with a conflicting duplicate', async (_name, pull) => {
    expect(await setup({ openPulls: [pull] }).decision()).toMatchObject({ state: 'success' });
  });

  it.each(['base_ref_changed', 'automatic_base_change_succeeded'])(
    'blocks reuse of a review after a %s event, even with current-head review evidence',
    async (event) => {
      const fixture = setup({ reviews: [REVIEW] });
      fixture.api.timeline.mockResolvedValue([{ event }]);
      expect(await fixture.decision()).toMatchObject({
        state: 'pending',
        description: expect.stringContaining('Open a new PR'),
      });
    },
  );

  it('allows an unchanged target despite unrelated PR activity', async () => {
    const fixture = setup();
    fixture.api.timeline.mockResolvedValue([{ event: 'labeled' }, { event: 'commented' }]);
    expect(await fixture.decision()).toMatchObject({ state: 'success' });
  });

  it('accepts a fresh thumbs-up from the verified bot, even when REST calls it a User', async () => {
    expect(await setup().decision()).toMatchObject({ state: 'success' });
  });

  it('accepts a fresh Codex thumbs-up on the manual review request without a PR-body reaction', async () => {
    const fixture = setup({
      comments: [SUMMARY, REVIEW_REQUEST],
      reactions: [],
      commentReactions: [THUMB],
    });
    expect(await fixture.decision()).toMatchObject({ state: 'success' });
    expect(fixture.api.commentReactions).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: REVIEW_REQUEST.id }),
    );
  });

  it.each([
    ['stale', { ...THUMB, created_at: '2026-09-14T21:09:45Z' }],
    ["another user's", { ...THUMB, user: { id: 123 } }],
  ])('rejects %s thumbs-up on the manual review request', async (_name, reaction) => {
    const fixture = setup({
      comments: [SUMMARY, REVIEW_REQUEST],
      reactions: [],
      commentReactions: [reaction],
    });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
  });

  it('does not accept thumbs-up from unrelated discussion comments', async () => {
    const fixture = setup({
      comments: [SUMMARY, { ...REVIEW_REQUEST, body: 'Please review this UI.' }],
      reactions: [],
      commentReactions: [THUMB],
    });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
    expect(fixture.api.commentReactions).not.toHaveBeenCalled();
  });

  it.each(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'])(
    'accepts a current-head submitted %s review; native thread protection handles findings',
    async (state) => {
      const fixture = setup({ reviews: [{ ...REVIEW, state }], reactions: [] });
      expect(await fixture.decision()).toMatchObject({ state: 'success' });
    },
  );

  it.each([
    ['an old review', { ...REVIEW, commit_id: OTHER_HEAD }],
    ['a human review', { ...REVIEW, user: { id: 123 } }],
    ['an unsubmitted review', { ...REVIEW, submitted_at: null }],
    ['a pending review', { ...REVIEW, state: 'PENDING' }],
    ['a dismissed review', { ...REVIEW, state: 'DISMISSED' }],
  ])('keeps merging blocked with only %s', async (_name, review) => {
    expect(await setup({ reviews: [review], reactions: [] }).decision()).toMatchObject({
      state: 'pending',
    });
  });

  it.each([
    ['a stale thumbs-up', { ...THUMB, created_at: '2026-09-14T21:09:45Z' }],
    ['a human thumbs-up', { ...THUMB, user: { ...BOT, id: 123 } }],
    ['an eyes reaction', { ...THUMB, content: 'eyes' }],
    ['an invalid reaction timestamp', { ...THUMB, created_at: 'invalid' }],
  ])('keeps merging blocked with only %s', async (_name, reaction) => {
    expect(await setup({ reactions: [reaction] }).decision()).toMatchObject({ state: 'pending' });
  });

  it('requires a unique authenticated summary, even when a valid review exists', async () => {
    for (const comments of [[], [{ ...SUMMARY, user: { ...BOT, id: 123 } }], [SUMMARY, SUMMARY]]) {
      const fixture = setup({ comments, reviews: [REVIEW] });
      expect(await fixture.decision()).toMatchObject({ state: 'pending' });
    }
  });

  it('rejects an earlier-head summary even when the PR still has a thumbs-up', async () => {
    const fixture = setup({
      comments: [{ ...SUMMARY, body: BODY.replace('`2db9380`', '`aa59380`') }],
    });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
  });

  it('rejects a summary edited by a human', async () => {
    const fixture = setup();
    fixture.github.graphql.mockResolvedValue({ node: { editor: {} } });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
  });

  it('allows a bot-authored summary that has never been edited', async () => {
    const fixture = setup();
    fixture.github.graphql.mockResolvedValue({ node: { editor: null } });
    expect(await fixture.decision()).toMatchObject({ state: 'success' });
  });

  it('does not trust a matching prefix when GitHub resolves it to another full commit', async () => {
    const fixture = setup();
    fixture.api.commit.mockResolvedValue({ data: { sha: `${HEAD.slice(0, -1)}5` } });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
  });

  it('fails closed when the abbreviated commit is ambiguous', async () => {
    const fixture = setup();
    fixture.api.commit.mockRejectedValue(new Error('Ambiguous commit'));
    await expect(fixture.decision()).rejects.toThrow('Ambiguous commit');
  });
});

describe('publishing the merge requirement', () => {
  it.each(['closed', 'synchronize', 'edited'])(
    'restores the original PR after a duplicate is %s',
    async (action) => {
      const original = { ...PULL, number: 3 };
      const duplicate = {
        ...PULL,
        number: 4,
        state: action === 'closed' ? 'closed' : 'open',
        head: { sha: action === 'synchronize' ? OTHER_HEAD : HEAD },
        base: { ref: action === 'edited' ? 'feature' : 'dev' },
      };
      const fixture = setup({
        openPulls: action === 'closed' ? [original] : [original, duplicate],
      });
      fixture.context.payload = { action, before: HEAD, pull_request: duplicate };
      fixture.api.pull.mockImplementation(({ pull_number }) =>
        Promise.resolve({ data: pull_number === 3 ? original : duplicate }),
      );
      await fixture.run();
      const statuses = fixture.api.status.mock.calls.map(([status]) => status);
      expect(statuses).toContainEqual(expect.objectContaining({ sha: HEAD, state: 'success' }));
      if (action === 'synchronize') {
        expect(statuses).toContainEqual(
          expect.objectContaining({ sha: OTHER_HEAD, state: 'pending' }),
        );
        expect(statuses).not.toContainEqual(
          expect.objectContaining({ sha: OTHER_HEAD, state: 'success' }),
        );
      }
    },
  );

  it('uses distinct requirements for the same commit against dev and main', async () => {
    const dev = setup();
    const main = setup();
    main.context.payload.pull_request.number = 4;
    main.api.pull.mockResolvedValue({ data: { ...PULL, base: { ref: 'main' } } });
    await dev.run();
    await main.run();
    const successfulStatus = (fixture) =>
      fixture.api.status.mock.calls
        .map(([status]) => status)
        .find(({ state }) => state === 'success');
    expect(successfulStatus(dev)).toMatchObject({ sha: HEAD, context: 'Codex review (dev)' });
    expect(successfulStatus(main)).toMatchObject({ sha: HEAD, context: 'Codex review (main)' });
    expect(main.api.timeline).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 4 }));
  });

  it('publishes pending before success, with both statuses attached to the reviewed full SHA', async () => {
    const fixture = setup();
    await fixture.run();
    expect(fixture.api.status.mock.calls.map(([status]) => [status.sha, status.state])).toEqual([
      [HEAD, 'pending'],
      [HEAD, 'success'],
    ]);
  });

  it('never publishes success if a new commit arrives during review verification', async () => {
    const fixture = setup();
    fixture.api.pull
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValue({ data: { ...PULL, head: { sha: OTHER_HEAD } } });
    await fixture.run();
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual(['pending']);
  });

  it('does not publish success if the PR closes during verification', async () => {
    const fixture = setup();
    fixture.api.pull
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValue({ data: { ...PULL, state: 'closed' } });
    await fixture.run();
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual(['pending']);
  });

  it('never publishes success if the target changes while the commit stays the same', async () => {
    const fixture = setup();
    fixture.api.pull
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValueOnce({ data: PULL })
      .mockResolvedValue({ data: { ...PULL, base: { ref: 'main' } } });
    await fixture.run();
    expect(fixture.api.status.mock.calls.map(([status]) => [status.context, status.state])).toEqual(
      [['Codex review (dev)', 'pending']],
    );
  });

  it.each([
    'openPulls',
    'timeline',
    'comments',
    'commit',
    'reviews',
    'reactions',
    'commentReactions',
    'graphql',
  ])('keeps merging blocked if the %s API fails', async (endpoint) => {
    const fixture = setup({ comments: [SUMMARY, REVIEW_REQUEST] });
    const method = endpoint === 'graphql' ? fixture.github.graphql : fixture.api[endpoint];
    method.mockRejectedValue(new Error('API unavailable'));
    await expect(fixture.run()).rejects.toThrow('API unavailable');
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual([
      'pending',
      'error',
    ]);
  });

  it('allows a short delivery delay between completion summary and thumbs-up', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.api.reactions.mockResolvedValueOnce([]).mockResolvedValue([THUMB]);
    const run = fixture.run();
    await vi.runAllTimersAsync();
    await run;
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual([
      'pending',
      'success',
    ]);
  });

  it('remains pending after the bounded wait if no completion outcome arrives', async () => {
    vi.useFakeTimers();
    const fixture = setup({ reactions: [] });
    const run = fixture.run();
    await vi.runAllTimersAsync();
    await run;
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual([
      'pending',
      'pending',
    ]);
  });
});

describe('standalone branch configuration', () => {
  it('defaults to main and accepts distinct literal names', () => {
    expect(parseBranches()).toEqual(['main']);
    expect(parseBranches(' main, develop\nrelease/1.x\r\nmain\n')).toEqual([
      'main',
      'develop',
      'release/1.x',
    ]);
  });

  it.each(['', ' \n, ', 'release/*', 'main develop', 'release/?', 'release/[ab]', 'bad\\name'])(
    'rejects ambiguous or empty configuration %j',
    (value) => {
      expect(() => parseBranches(value)).toThrow('literal branch names');
    },
  );

  it('publishes a destination-specific status for a custom protected branch', async () => {
    const fixture = setup({ protectedBranches: ['develop'] });
    fixture.api.pull.mockResolvedValue({ data: { ...PULL, base: { ref: 'develop' } } });
    await fixture.run();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: 'Codex review (develop)',
        state: 'success',
      }),
    );
  });

  it('skips branches not configured by the consumer', async () => {
    const fixture = setup({ protectedBranches: ['main'] });
    await fixture.run();
    expect(fixture.api.status).not.toHaveBeenCalled();
  });

  it('detects duplicate heads against a custom protected branch', async () => {
    const fixture = setup({
      protectedBranches: ['develop'],
      openPulls: [{ ...PULL, number: 4, base: { ref: 'develop' } }],
    });
    expect(await fixture.decision()).toMatchObject({ state: 'pending' });
  });

  it('refreshes the original PR on a custom branch after its duplicate closes', async () => {
    const original = { ...PULL, number: 3, base: { ref: 'develop' } };
    const duplicate = { ...original, number: 4, state: 'closed' };
    const fixture = setup({ protectedBranches: ['develop'], openPulls: [original] });
    fixture.context.payload = { action: 'closed', pull_request: duplicate };
    fixture.api.pull.mockImplementation(({ pull_number }) =>
      Promise.resolve({ data: pull_number === 3 ? original : duplicate }),
    );
    await fixture.run();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: 'Codex review (develop)',
        state: 'success',
      }),
    );
  });

  it('does not reuse the GitHub.com bot identity on another server', async () => {
    const fixture = setup();
    fixture.context.serverUrl = 'https://github.example.com';
    await expect(fixture.run()).rejects.toThrow('GitHub.com only');
    expect(fixture.api.status).not.toHaveBeenCalled();
  });

  it.each([0, -1, 'bad', '1.5', '9007199254740992'])(
    'rejects invalid PR number %s before publishing a status',
    async (number) => {
      const fixture = setup();
      fixture.context.payload = { inputs: { pr: number } };
      await expect(fixture.run()).rejects.toThrow('valid PR number');
      expect(fixture.api.status).not.toHaveBeenCalled();
    },
  );
});

describe('composite action entry point', () => {
  const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
  const execute = compileFunction(
    `return (async () => { ${action.runs.steps[0].with.script} })()`,
    ['github', 'context', 'core'],
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  );
  const runAction = (fixture, pr = '', timeout = '0') => {
    vi.stubEnv('CODEX_GATE_ACTION_PATH', fileURLToPath(new URL('..', import.meta.url)));
    vi.stubEnv('CODEX_GATE_BRANCHES', 'develop');
    vi.stubEnv('CODEX_GATE_PR', pr);
    vi.stubEnv('CODEX_GATE_REVIEW_TIMEOUT', timeout);
    fixture.api.pull.mockResolvedValue({ data: { ...PULL, base: { ref: 'develop' } } });
    return execute(fixture.github, fixture.context, { info: vi.fn() });
  };

  it('loads the packaged module and handles a PR event with configured branches', async () => {
    const fixture = setup();
    await runAction(fixture);
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        owner: 'example',
        repo: 'game',
        context: 'Codex review (develop)',
        state: 'success',
      }),
    );
  });

  it('infers the PR number from a Codex issue-comment event', async () => {
    const fixture = setup();
    fixture.context.payload = { issue: { number: 12, pull_request: {} } };
    await runAction(fixture);
    expect(fixture.api.pull).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 12 }));
  });

  it('accepts a manual PR input while preserving the real Context repo getter', async () => {
    const fixture = setup();
    const { repo, ...fields } = fixture.context;
    fixture.context = Object.assign(
      Object.create({
        get repo() {
          return repo;
        },
      }),
      fields,
    );
    await runAction(fixture, '9');
    expect(fixture.api.pull).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'game',
      pull_number: 9,
    });
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'success',
        context: 'Codex review (develop)',
      }),
    );
  });

  it('wires the optional timeout input into the action', async () => {
    vi.useFakeTimers();
    const fixture = setup({ comments: [] });
    const run = runAction(fixture, '', '12');
    await vi.runAllTimersAsync();
    await run;
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'success',
        description: expect.stringContaining('wait expired after 12 min'),
      }),
    );
  });

  it('rejects invalid timeout input before reaching GitHub', async () => {
    const fixture = setup();
    await expect(runAction(fixture, '', '-1')).rejects.toThrow('review-timeout-minutes');
    expect(fixture.api.pull).not.toHaveBeenCalled();
  });

  it('rejects code-shaped PR input as invalid data before reaching GitHub', async () => {
    const fixture = setup();
    await expect(runAction(fixture, '1; throw new Error("executed")')).rejects.toThrow(
      'valid PR number',
    );
    expect(fixture.api.pull).not.toHaveBeenCalled();
  });
});

const START = Date.parse('2026-09-17T00:00:00Z');
function marker(overrides = {}) {
  return {
    sha: HEAD,
    context: 'Codex review (dev)',
    state: 'pending',
    description: 'Codex review wait started (PR #3).',
    creator: { id: ACTIONS_BOT_ID },
    target_url: 'https://github.com/example/game/actions/runs/99',
    created_at: new Date(START).toISOString(),
    ...overrides,
  };
}
function timeoutSetup({ elapsed = 0, ...options } = {}) {
  let time = START + elapsed;
  const sleep = vi.fn(async (ms) => {
    time += ms;
  });
  const fixture = setup({
    comments: [],
    reviewTimeoutMinutes: 12,
    now: () => time,
    sleep,
    ...options,
  });
  return { ...fixture, sleep, elapsed: () => time - START };
}

describe('optional review timeout', () => {
  it.each(['-1', '1.5', '61', 'abc', '', ' 12', '12;process.exit()', 'Infinity'])(
    'rejects invalid input %j',
    (value) => {
      expect(() => parseReviewTimeoutMinutes(value)).toThrow('review-timeout-minutes');
    },
  );

  it('defaults to strict mode and accepts a bounded integer', () => {
    expect(parseReviewTimeoutMinutes()).toBe(0);
    expect(parseReviewTimeoutMinutes('12')).toBe(12);
    expect(parseReviewTimeoutMinutes('60')).toBe(60);
  });

  it('records a fresh clock, waits twelve minutes, and explicitly reports review bypass', async () => {
    const fixture = timeoutSetup();
    await fixture.run();
    expect(fixture.elapsed()).toBe(720_000);
    expect(fixture.api.status.mock.calls.map(([status]) => status.state)).toEqual([
      'pending',
      'pending',
      'success',
    ]);
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'success',
        description: 'Review wait expired after 12 min; no verified Codex review.',
      }),
    );
  });

  it.each([719_000, 720_000])(
    'does not pass before the persisted twelve-minute boundary (%i ms)',
    async (elapsed) => {
      const fixture = timeoutSetup({ elapsed, statusHistory: [marker()] });
      await fixture.run();
      expect(fixture.elapsed()).toBe(720_000);
      expect(fixture.sleep.mock.calls).toEqual(elapsed === 719_000 ? [[1000]] : []);
      expect(fixture.api.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'success' }),
      );
    },
  );

  it('retains the original clock on rerun and comment edits', async () => {
    const history = [marker()];
    const fixture = timeoutSetup({ elapsed: 600_000, statusHistory: history });
    fixture.context.payload = { issue: { number: 3, pull_request: {} }, action: 'edited' };
    await fixture.run();
    expect(fixture.elapsed()).toBe(720_000);
    expect(history.filter((status) => status.description === marker().description)).toHaveLength(1);
  });

  it.each([
    ['another commit', { sha: OTHER_HEAD }],
    ['another PR', { description: 'Codex review wait started (PR #4).' }],
    ['another base', { context: 'Codex review (main)' }],
    ['a human status', { creator: { id: 123 } }],
    ['another repository run', { target_url: 'https://github.com/attacker/repo/actions/runs/99' }],
    ['a non-workflow URL', { target_url: 'https://github.com/example/game/pull/3' }],
    ['a success status', { state: 'success' }],
    ['a non-marker status', { description: 'Waiting for Codex to review this commit.' }],
  ])('does not reuse %s to backdate the timer', async (_label, overrides) => {
    const fixture = timeoutSetup({ elapsed: 720_000, statusHistory: [marker(overrides)] });
    await fixture.run();
    expect(fixture.elapsed()).toBe(1_440_000);
  });

  it.each(['invalid', '2026-09-18T00:00:00Z'])(
    'fails closed on an invalid trusted timer timestamp %s',
    async (created_at) => {
      const fixture = timeoutSetup({ statusHistory: [marker({ created_at })] });
      await expect(fixture.run()).rejects.toThrow('Invalid GitHub timestamp');
      expect(fixture.api.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'error' }),
      );
    },
  );

  it('accepts a genuine review immediately without starting a timer', async () => {
    const fixture = timeoutSetup({ comments: [SUMMARY] });
    await fixture.run();
    expect(fixture.sleep).not.toHaveBeenCalled();
    expect(fixture.api.statuses).not.toHaveBeenCalled();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'success',
        description: expect.stringContaining('Codex reviewed'),
      }),
    );
  });

  it('accepts a genuine review that arrives during the wait', async () => {
    const fixture = timeoutSetup();
    fixture.api.comments.mockResolvedValueOnce([]).mockResolvedValue([SUMMARY]);
    await fixture.run();
    expect(fixture.elapsed()).toBe(30_000);
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'success',
        description: expect.stringContaining('Codex reviewed'),
      }),
    );
  });

  it.each([
    ['new head', { head: { sha: OTHER_HEAD } }],
    ['new base', { base: { ref: 'main' } }],
    ['closed PR', { state: 'closed' }],
  ])('publishes no stale success if there is a %s while waiting', async (_label, change) => {
    const fixture = timeoutSetup();
    fixture.sleep.mockImplementationOnce(async () => {
      fixture.api.pull.mockResolvedValue({ data: { ...PULL, ...change } });
    });
    await fixture.run();
    expect(fixture.api.status.mock.calls.some(([status]) => status.state === 'success')).toBe(
      false,
    );
  });

  it.each(['statuses', 'comments', 'timeline', 'openPulls'])(
    'does not treat a %s API failure as a timeout',
    async (endpoint) => {
      const fixture = timeoutSetup({ elapsed: 720_000, statusHistory: [marker()] });
      fixture.api[endpoint].mockRejectedValue(new Error('API unavailable'));
      await expect(fixture.run()).rejects.toThrow('API unavailable');
      expect(fixture.api.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'error' }),
      );
    },
  );

  it('does not bypass duplicate open heads after twelve minutes', async () => {
    const fixture = timeoutSetup({
      elapsed: 720_000,
      statusHistory: [marker()],
      openPulls: [{ ...PULL, number: 4 }],
    });
    await fixture.run();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'pending',
        description: expect.stringContaining('Another open PR'),
      }),
    );
  });

  it('does not bypass retargeted PRs after twelve minutes', async () => {
    const fixture = timeoutSetup({ elapsed: 720_000, statusHistory: [marker()] });
    fixture.api.timeline.mockResolvedValue([{ event: 'base_ref_changed' }]);
    await fixture.run();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'pending',
        description: expect.stringContaining('Target branch changed'),
      }),
    );
  });

  it('never uses timeout markers when the option is disabled', async () => {
    const fixture = timeoutSetup({
      reviewTimeoutMinutes: 0,
      elapsed: 720_000,
      statusHistory: [marker()],
    });
    await fixture.run();
    expect(fixture.sleep).not.toHaveBeenCalled();
    expect(fixture.api.statuses).not.toHaveBeenCalled();
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'pending' }),
    );
  });

  it('requires a GitHub Actions-created timer marker', async () => {
    const fixture = timeoutSetup();
    fixture.api.status.mockResolvedValue({ data: marker({ creator: { id: 123 } }) });
    await expect(fixture.run()).rejects.toThrow('GitHub Actions token');
    expect(fixture.api.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'error' }),
    );
  });
});
