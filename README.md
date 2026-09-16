# Codex Review Gate

Make a completed Codex review of the latest PR commit a required GitHub status.

An independent, MIT-licensed community GitHub Action. It reads the review evidence produced by Codex's GitHub integration and publishes `Codex review (<target branch>)`. Use GitHub's **Require conversation resolution** setting alongside it to block merging while review threads remain unresolved.

The gate works on GitHub.com and has no connection to your application's language, framework, dependencies or test runner. Codex must already be configured to review your repository; this action checks reviews and does not request them.

## Install

1. Copy [`examples/codex-review.yml`](examples/codex-review.yml) to `.github/workflows/codex-review.yml` in your repository's default branch.
2. Set `protected-branches` to your literal target branch names, for example:

   ```yaml
   - uses: lakshyashastri/codex-review-gate@v0.2.0
     with:
       protected-branches: |
         main
         develop
       pull-request-number: ${{ inputs.pr }}
   ```

3. Open a PR against a configured branch so the action publishes its status. The status can be pending while you configure protection.
4. In that branch's protection rule or ruleset, require `Codex review (main)` (or the exact corresponding branch name), select **GitHub Actions** as its expected source, and enable **Require conversation resolution**. Keep your CI requirements enabled too. For example, `develop` needs `Codex review (develop)`; requiring one branch's status on another branch will block it indefinitely.

The example workflow includes the necessary triggers, permissions, per-PR concurrency and manual rerun input. A `uses` step alone does not configure them. Install the workflow on the default branch so comment events and manual dispatch can reach it. Protect that branch and review changes to this workflow as trusted infrastructure.

For an immutable installation, replace the release tag with its full commit SHA from [the release](https://github.com/lakshyashastri/codex-review-gate/releases). There is no installation or checkout step in the gate job.

### Inputs

| Input                    | Default               | Purpose                                                                                                  |
| ------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `protected-branches`     | `main`                | Exact branch names, separated by commas or newlines. No wildcards.                                       |
| `review-timeout-minutes` | `0` (strict)          | Optionally pass without a verified review after 1–60 minutes. Requires the default GitHub Actions token. |
| `pull-request-number`    | Inferred from event   | Explicit PR number for a manual run. The example supplies its `pr` input.                                |
| `github-token`           | `${{ github.token }}` | Repository token with the permissions below. The default GitHub Actions token is sufficient.             |

```yaml
permissions:
  contents: read
  issues: read
  pull-requests: read
  statuses: write
```

The merge requirement is the **commit status** named `Codex review (<branch>)`, not the workflow job named “Update Codex review status”. A successful workflow run can still leave that commit status pending while Codex reviews the PR.

## Optional review timeout

Strict verification remains the default. To stop waiting indefinitely for Codex, opt in:

```yaml
timeout-minutes: 15 # Job timeout must exceed the configured review wait.
steps:
  - uses: lakshyashastri/codex-review-gate@v0.2.0
    with:
      protected-branches: main
      review-timeout-minutes: '12'
```

Keep all the triggers, permissions and concurrency settings from the complete example workflow. The action polls every 30 seconds during the wait; no scheduled workflow is needed. It can pass earlier when the normal review evidence arrives. This consumes GitHub Actions runner time while waiting. Workflow queueing and API latency mean twelve minutes is a review waiting period, not an exact guarantee measured from the push.

The clock starts when the gate first records that it is waiting for a review of this PR's current commit and target branch. A pending commit status records the start using GitHub's timestamp. Reruns, workflow cancellation and summary edits reuse that clock. A new head commit starts a new clock; enabling the option on an existing PR also starts fresh unless this marker already exists. Commit author dates and older unmarked pending statuses cannot backdate it. Use the default `github-token`: timeout markers must be authored by GitHub Actions' verified bot (numeric account ID `41898282`) and link to a workflow run in this repository.

**A timeout is a review bypass, not evidence of approval.** After twelve minutes without verifiable completion, the status succeeds with “Review wait expired after 12 min; no verified Codex review.” This includes Codex being slow or rate-limited and a missing/stale/unrecognized summary. API errors, invalid timer evidence, duplicate open PRs sharing the commit, and retargeted PRs still do not pass through the timeout.

Keep **Require conversation resolution** enabled. Existing and late-arriving unresolved threads still block merging through GitHub's native protection, even after this status passes. A review can arrive after the PR has already been merged; the timeout deliberately accepts that possibility. All other required CI checks remain independent.

If a workflow is canceled and no replacement runs, or exceeds its job timeout, the status can remain pending. Rerun the workflow to resume the persisted wait. Set `review-timeout-minutes: '0'` to restore strict verification and rerun affected PRs; existing successful statuses are not automatically revoked by changing configuration.

## What counts as completed in strict verification

All of the following must hold:

- Exactly one summary comment was authored by Codex's GitHub.com bot (numeric account ID `199175422`). Its last editor must also be that bot, or it must never have been edited.
- Its **Code Review** row has the recognized **Completed** format and a valid completion timestamp.
- The reviewed commit abbreviation resolves through GitHub to the exact current PR head commit.
- Either Codex submitted a `COMMENTED`, `APPROVED` or `CHANGES_REQUESTED` review for that exact commit, or Codex left a fresh 👍 on the PR body or an `@codex review` request comment. A reaction counts only alongside the independently verified completed summary, and must be at or after completion to GitHub's second precision.

A 👀 reaction, a human's 👍, a stale summary or an old review is insufficient. The gate checks the head and target branch again before publishing success. Closed PRs and unconfigured target branches are skipped.

The optional timeout above is a separate path to success; it does not change these review-evidence rules. A completed review **with findings** satisfies review completion. GitHub's conversation-resolution requirement separately blocks unresolved review threads, including outdated ones. Resolving a thread acknowledges the finding; this gate does not verify that the code fixes it or judge whether a dismissal is justified. Pushed fixes need a review of the new commit.

## Limits and troubleshooting

This is a lightweight merge gate, not an absolute per-PR lock:

- **Shared commit statuses.** GitHub associates statuses with commits. A second PR reusing an approved commit can briefly inherit success before its workflow runs. The action blocks detected duplicate open PRs against configured targets and refreshes related statuses when duplicates move or close, but concurrent runs can still overwrite shared statuses. Keep open PRs on distinct commits. If a refresh is missed, rerun the workflow for the affected PR.
- **Retargeted PRs.** Codex's summary identifies a commit, not the reviewed base branch. Any recorded target-branch change blocks the PR, even if a later review completes. Open a new PR against the intended target.
- **Observed summary format.** The parser uses Codex's observed Markdown output, not a stable public completion API. Unknown or changed formats remain pending in strict mode until the parser is updated. With a review timeout enabled, they can pass once its wait expires. API failures always produce an error status instead of success.
- **Reaction delivery.** Codex's comment creation/edits trigger checks. Reactions have no dedicated workflow trigger; the action waits up to 30 seconds for a submitted review or 👍 after a completed summary appears. If it arrives later in strict mode, run **Codex review gate** from Actions with the PR number. With a timeout enabled, the action continues checking during its configured wait.
- **Automatic reviews.** If pushing new code has not started a review, request one using your Codex integration, for example by commenting `@codex review`.
- **Permissions and policy.** Actions and the required token permissions must be allowed by your repository or organization. GitHub Enterprise Server is unsupported because the verified bot identity is GitHub.com-specific. Merge queues are not supported by the supplied workflow.

When debugging a pending status, follow its details link, inspect the summary's reviewed commit, and check the above conditions. Avoid editing the bot's summary yourself.

## Security model

The gate reads PR metadata and writes commit statuses. It never executes PR source code. The example uses `pull_request_target` for PR events and `issue_comment` for Codex summary updates, with no checkout, artifact download, cache restore or package installation in the privileged job. Keep application builds and tests in separate jobs with their own permissions.

The composite action uses a pinned `actions/github-script` release to provide GitHub's API client. Configuration is passed through environment variables, not interpolated into executable JavaScript. Review text and reactions are treated as data; authorship, editor identity and full commit identity are verified through GitHub.

See GitHub's [composite action documentation](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action) and [pull_request_target security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

## Development

Use Node 24 and npm:

```sh
npm ci --ignore-scripts
npm run verify
```

`npm run verify` runs formatting checks and tests, matching CI. Tests use synthetic GitHub API responses and cover summary parsing, bot identity, stale evidence, branch configuration, event handling, status publication, API failures, timeout boundaries, durable clocks across reruns, head changes and the composite action's entry point. No application server, database or credentials are needed for local tests.

Keep the parser conservative: add representative, sanitized fixtures when Codex's format changes, and prove that stale or ambiguous evidence remains blocked. Publish a new versioned release for behavior changes.

## License

[MIT](LICENSE). This project is independently maintained and is not an official OpenAI or GitHub product.
