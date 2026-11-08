# upload-actions-logs

A GitHub Action that sends your GitHub Actions job logs, plus a summary record for each run, job and step, to [Sazabi](https://sazabi.com) as OpenTelemetry log records. It runs in your own workflow after each run completes, reads logs with the repository's own `GITHUB_TOKEN`, and pushes them to your Sazabi log source.

**Status:** not released yet. The first version (`v1`) and setup instructions will be published here and at [docs.sazabi.com](https://docs.sazabi.com).

## Issues & support

File issues here or at [support@sazabi.ai](mailto:support@sazabi.ai). Report security issues per [SECURITY.md](SECURITY.md).
