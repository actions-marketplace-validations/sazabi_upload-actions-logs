# upload-actions-logs

A GitHub Action that sends GitHub Actions job logs and run, job and step summaries to Sazabi as OpenTelemetry log records. Usage and inputs: [README.md](README.md). Setup guide: [docs.sazabi.com](https://docs.sazabi.com/catalogs/log-sources/send-to-an-endpoint/github-actions).

## About

This is a release mirror. The action is developed in the private Sazabi monorepo; each release lands here as the exact files published to the GitHub Marketplace (`action.yaml`, the bundled `dist/index.js`, and this documentation). Do not commit directly: content is published here by a maintainer-dispatched release run, and direct commits are overwritten by the next release.

## Working on the source

- `src/` is TypeScript with no runtime dependencies; `bun run build` bundles it into `dist/index.js` (Node 24, ES modules). The bundle is built at release time and never committed to the source tree.
- The action must never fail the caller's workflow unless `fail-on-error` is `true`: every error becomes a warning.
- The intake URL is a credential. Mask it, never print it, and never put a request's URL or a network error's message (which can name the host) into a warning.
- Record names are a public contract: OpenTelemetry `cicd.*` and `vcs.*` names first, `github.*` for facts with no convention, never vendor-prefixed names. Renaming or removing one is a major version.
- Public copy says what the action sends, not what Sazabi does with it.

## Issues & support

File issues here or at [support@sazabi.ai](mailto:support@sazabi.ai).
