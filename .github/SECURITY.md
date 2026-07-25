# Security Policy

## Supported Versions

Only the latest published release (the most recent immutable `vX.Y.Z` tag) is supported with security fixes. There are no floating major/minor tags (see [Versioning](../README.md#versioning)), so always pin to and upgrade to the latest tag to receive fixes.

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting for this repository:

1. Go to the [Security tab](https://github.com/raven-actions/repo-files-sync/security).
1. Click **"Report a vulnerability"**.
1. Provide a description of the issue, steps to reproduce, and its potential impact.

You can expect an initial response within a few business days. We will work with you to confirm the issue, develop a fix, and coordinate disclosure timing before any public release notes or advisory are published.

## Scope Notes

This action requires a `GH_TOKEN` capable of reading/writing to target repositories (and creating pull requests). By design:

- Whoever can push to the source repository's default branch (or otherwise trigger the sync workflow) controls `sync.yml`, and therefore controls which target repositories and files are affected. Treat that push access with the same trust level as the token itself.
- Enabling `template` on a file causes its content to be rendered as a [Nunjucks](https://mozilla.github.io/nunjucks/) template. Nunjucks does not sandbox template execution itself, so by default this action hardens rendering against the most common escape technique (property-access chains such as `constructor`/`__proto__` that reach a JavaScript constructor). This is a best-effort mitigation, not a full sandbox, and can be turned off with `TEMPLATE_SANDBOX: false` (not recommended; logs a warning every run while disabled). Only enable `template` for files whose full content you trust; see the [README warning](../README.md#using-templates) for details.

Reports about these documented, inherent trust boundaries are welcome as hardening suggestions, but are handled as enhancements rather than security incidents. Genuine boundary bypasses (e.g. path traversal outside the intended repository root, command/argument injection, or credential leakage) are treated as vulnerabilities.
