# Upload Actions Logs to Sazabi

A GitHub Action that sends your GitHub Actions job logs, and a summary of every workflow run, job and step, to [Sazabi](https://www.sazabi.com) as OpenTelemetry log records. Add one workflow file and every run in the repository is covered; your existing workflows don't change.

Setup guide: [docs.sazabi.com/catalogs/log-sources/send-to-an-endpoint/github-actions](https://docs.sazabi.com/catalogs/log-sources/send-to-an-endpoint/github-actions)

## Usage

1. In Sazabi, add a **GitHub Actions** log source and copy its intake URL.
2. Save the URL as a repository (or organization) secret named `SAZABI_LOGS_URL`. The URL carries your source's key, so keep it in a secret, never in a workflow file.
3. Add `.github/workflows/sazabi-logs.yml`:

```yaml
name: Sazabi logs
on:
  workflow_run:
    workflows: ["**", "!Sazabi logs"]
    types: [completed]
permissions:
  actions: read
jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: sazabi/upload-actions-logs@v1
        with:
          url: ${{ secrets.SAZABI_LOGS_URL }}
```

When any other workflow run completes, this workflow reads the run's jobs and job logs through the GitHub API and sends them to Sazabi.

- `"**"` matches every workflow name. `"!Sazabi logs"` keeps the workflow from triggering on its own runs; add more `"!Name"` entries to leave other workflows out.
- `workflow_run` always runs the workflow file from your default branch, and the action never checks out or runs code from the run it uploads, so pull requests from forks can't reach the secret.
- GitHub only triggers `workflow_run` from a workflow file on the default branch, so uploads start once this file is merged there.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `url` | required | Your log source's intake URL, from a secret |
| `logs` | `true` | `false` sends the run, job and step summaries only |
| `max-bytes-per-job` | `10485760` | The most log text sent per job (10 MB) |
| `service-name` | repository name | The `service.name` of every record |
| `fail-on-error` | `false` | Fail the job when the upload or a job log download fails |
| `github-token` | `${{ github.token }}` | Token for the jobs and logs API; needs `actions: read` |

## What it sends

Every record uses the OpenTelemetry [CI/CD](https://opentelemetry.io/docs/specs/semconv/registry/attributes/cicd/) and [VCS](https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/) attribute names, with `github.*` names for facts that have no convention.

| Record | Attributes |
| --- | --- |
| Every record (resource) | `service.name`, `vcs.provider.name` (`github`), `vcs.owner.name`, `vcs.repository.name`, `vcs.repository.url.full`, `vcs.ref.head.name`, `vcs.ref.head.revision`, `vcs.change.id` (pull request number, when there is one), `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.run.url.full`, `github.run.attempt`, `github.event_name`, `github.actor` |
| Run summary | `event.name` = `github.actions.run`, `cicd.pipeline.result`, `github.conclusion`, `github.duration_ms`, `github.queue_duration_ms`, `github.job_count` |
| Job summary | `event.name` = `github.actions.job`, `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, `cicd.pipeline.task.run.url.full`, `cicd.pipeline.task.run.result`, `github.conclusion`, `cicd.worker.name`, `cicd.worker.id`, `github.runner.group`, `github.runner.labels`, `github.duration_ms`, `github.queue_duration_ms` |
| Step summary | `event.name` = `github.actions.step`, the job attributes, `github.step.name`, `github.step.number`, `github.conclusion`, `github.duration_ms` |
| Log line | The job attributes, `github.step.name` and `github.step.number` when the line can be matched to a step, `github.log.line` (1-based) |

- **Results.** GitHub's conclusions map to `cicd.*.result` values: `success`, `failure`, `cancelled` → `cancellation`, `skipped` → `skip`, `timed_out` → `timeout`, `startup_failure` → `error`. `github.conclusion` always keeps GitHub's value.
- **Severity.** A summary is WARN when its conclusion is `failure`, `timed_out`, `cancelled`, `startup_failure` or `action_required`, otherwise INFO. A log line is ERROR for `##[error]`, WARN for `##[warning]`, otherwise INFO.
- **Timestamps.** A log line keeps GitHub's timestamp (removed from the line's text). A summary carries its completion time.
- **Steps.** A line is matched to the step whose start and end times contain its timestamp. Within a second shared by two steps, the step header (`##[group]Run …`) decides. A line no step contains, such as job setup output, carries the job attributes only.
- **Large logs.** Over `max-bytes-per-job`, a job sends the first tenth and the last nine tenths of the cap, plus one record with `github.log.truncated` = `true` and `github.log.omitted_bytes`. Summaries are always sent.
- **Duplicates.** Each record has a deterministic `log.record.uid`, so a record sent twice (a retried request, a redelivered event) can be recognized. Re-running a workflow creates a new attempt with new IDs.
- **Long runs.** Sazabi accepts records up to 24 hours old. A record more than 23 hours older than the upload is sent with the upload time and keeps its real time in `github.original_time`; the action prints a warning with the count.

## Failures

An upload error, or a job log GitHub won't serve, prints a workflow warning and the job still succeeds, so a Sazabi outage never turns your checks red. Set `fail-on-error: true` to fail the job instead, after every summary is sent. Requests are retried with backoff on rate limits, server errors, network errors and timeouts.

## Organization-wide setup

To offer the workflow to every repository in your organization, add it as a [workflow template](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates) in your organization's `.github` repository, and save `SAZABI_LOGS_URL` as an organization secret. The setup guide has both files.

## Versioning

Use `@v1` to get fixes and additions within version 1, or pin an exact release such as `@v1.0.0` (or its commit SHA). Inputs and record names don't change within a major version.

## License

[Apache-2.0](LICENSE)
