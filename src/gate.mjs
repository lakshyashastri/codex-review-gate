export const CODEX_BOT_ID = 199175422;
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';

// This is Codex's observed GitHub summary format, not a public API contract.
// Unknown formats must keep merging blocked until this parser is updated.
export function completedReview(body) {
  if (!body?.startsWith(SUMMARY_MARKER)) return null;
  const rows = body.split('\n').filter((line) => line.includes('**Code Review**'));
  if (rows.length !== 1) return null;
  const match = rows[0].match(
    /^\|\s*📝 \*\*Code Review\*\*\s*\|\s*✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">[^<]+<\/relative-time>\s*\|\s*`([0-9a-f]{7,40})`\s*\|[^|]*\|\s*$/,
  );
  if (!match) return null;
  const completedAt = Date.parse(match[1]);
  return Number.isFinite(completedAt) ? { commit: match[2], completedAt } : null;
}

export async function reviewDecision({
  github,
  owner,
  repo,
  number,
  headSha,
  protectedBranches = ['main'],
}) {
  const openPulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  if (
    openPulls.some(
      (pull) =>
        pull.number !== number &&
        pull.head.sha === headSha &&
        protectedBranches.includes(pull.base.ref),
    )
  ) {
    return {
      state: 'pending',
      description: 'Another open PR uses this commit. Push a unique commit.',
    };
  }
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  // The summary identifies a commit, not a base branch. A retargeted PR needs a
  // new PR/review rather than reusing evidence for its previous base-specific diff.
  if (
    events.some((event) =>
      ['base_ref_changed', 'automatic_base_change_succeeded'].includes(event.event),
    )
  ) {
    return {
      state: 'pending',
      description: 'Target branch changed. Open a new PR for a fresh Codex review.',
    };
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  const summaries = comments.filter(
    (comment) => comment.user?.id === CODEX_BOT_ID && comment.body?.startsWith(SUMMARY_MARKER),
  );
  const waiting = { state: 'pending', description: 'Waiting for Codex to review this commit.' };
  if (summaries.length !== 1) return waiting;
  const summary = summaries[0];
  const review = completedReview(summary.body);
  if (!review || !headSha.startsWith(review.commit)) return waiting;

  // Repository writers can edit someone else's comment. Verify its last editor too.
  const { node } = await github.graphql(
    `query($id: ID!) {
      node(id: $id) {
        ... on IssueComment { editor { ... on Bot { databaseId } } }
      }
    }`,
    { id: summary.node_id },
  );
  if (!node || (node.editor !== null && node.editor?.databaseId !== CODEX_BOT_ID)) {
    return waiting;
  }
  // Resolve the abbreviation through GitHub instead of trusting a prefix match alone.
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: review.commit });
  if (commit.sha !== headSha) return waiting;

  const requests = comments.filter(
    (comment) => comment.user?.id !== CODEX_BOT_ID && /@codex\s+review\b/i.test(comment.body ?? ''),
  );
  const [reviews, issueReactions, ...commentReactions] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    }),
    github.paginate(github.rest.reactions.listForIssue, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    }),
    ...requests.map((comment) =>
      github.paginate(github.rest.reactions.listForIssueComment, {
        owner,
        repo,
        comment_id: comment.id,
        per_page: 100,
      }),
    ),
  ]);
  const reactions = [...issueReactions, ...commentReactions.flat()];
  const submitted = reviews.some(
    (item) =>
      item.user?.id === CODEX_BOT_ID &&
      item.commit_id === headSha &&
      ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(item.state) &&
      item.submitted_at,
  );
  // Reactions have second precision and no commit ID. Only use a fresh thumbs-up
  // alongside the independently verified, completed summary for this exact commit.
  const thumbsUp = reactions.some(
    (item) =>
      item.user?.id === CODEX_BOT_ID &&
      item.content === '+1' &&
      Date.parse(item.created_at) >= Math.floor(review.completedAt / 1000) * 1000,
  );
  if (!submitted && !thumbsUp) return { ...waiting, retry: true };
  return {
    state: 'success',
    description: 'Codex reviewed this commit. All review threads must also be resolved.',
    target_url: summary.html_url,
  };
}

async function updateReviewStatus({ github, context, core, number, protectedBranches }) {
  const { owner, repo } = context.repo;
  const getPull = async () =>
    (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
  const pull = await getPull();
  if (pull.state !== 'open' || !protectedBranches.includes(pull.base.ref)) return;
  const headSha = pull.head.sha;
  const baseRef = pull.base.ref;
  const publish = (result) =>
    github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      // Statuses belong to a commit, not a PR. Different target branches need
      // distinct requirements because their reviewed diffs can differ.
      context: `Codex review (${baseRef})`,
      target_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
      state: result.state,
      description: result.description,
      ...(result.target_url ? { target_url: result.target_url } : {}),
    });
  await publish({ state: 'pending', description: 'Checking Codex review of this commit.' });
  try {
    let decision;
    // The summary edit can arrive a few seconds before the reaction/review. There
    // is no reaction webhook, so allow a short bounded grace period for delivery.
    for (let attempt = 0; attempt < 7; attempt++) {
      decision = await reviewDecision({ github, owner, repo, number, headSha, protectedBranches });
      if (!decision.retry || attempt === 6) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const latest = await getPull();
    if (latest.state !== 'open' || latest.head.sha !== headSha || latest.base.ref !== baseRef)
      return;
    await publish(decision);
    core.info(decision.description);
  } catch (error) {
    await publish({
      state: 'error',
      description: 'Unable to verify Codex review. Re-run this workflow.',
    });
    throw error;
  }
}

export default async function runGate({ github, context, core, protectedBranches = ['main'] }) {
  if (context.serverUrl !== 'https://github.com')
    throw new Error(
      'This action supports GitHub.com only; its Codex bot identity is GitHub.com-specific.',
    );
  const number = Number(
    context.payload.pull_request?.number ??
      context.payload.issue?.number ??
      context.payload.inputs?.pr,
  );
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error('A valid PR number is required.');
  const numbers = new Set([number]);
  // A duplicate PR may have made another PR's shared status pending. Refresh the
  // original when the duplicate closes or moves to a different head commit.
  const affectedHeads = [context.payload.before, context.payload.pull_request?.head?.sha].filter(
    Boolean,
  );
  if (affectedHeads.length) {
    const pulls = await github.paginate(github.rest.pulls.list, {
      ...context.repo,
      state: 'open',
      per_page: 100,
    });
    for (const pull of pulls) {
      if (affectedHeads.includes(pull.head.sha) && protectedBranches.includes(pull.base.ref))
        numbers.add(pull.number);
    }
  }
  const results = await Promise.allSettled(
    [...numbers].map((pr) =>
      updateReviewStatus({ github, context, core, number: pr, protectedBranches }),
    ),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

// Accept literal branch names, separated by commas or newlines. No glob matching.
export function parseBranches(value = 'main') {
  const branches = [
    ...new Set(
      value
        .split(/[\r\n,]+/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (!branches.length || branches.some((name) => /[\s*?\[\]\\]/.test(name)))
    throw new Error(
      'protected-branches must contain literal branch names, separated by commas or newlines.',
    );
  return branches;
}
