# Secret scanning

Run a local scan from the repository root:

```sh
node .github/scripts/scan-repository-code.mjs
```

The scanner examines tracked and non-ignored source/configuration files and writes `secret-scanning-code-report.md` and `secret-scanning-code-report.json` in the current directory. The reports contain finding type and file/line only. Detected values are not written to the reports or sent to an external service. This is a conservative pattern scan, not proof that a value is an active secret.

On pushes to `main` and manual workflow runs, GitHub Actions performs the same code scan and publishes its report as the `repository-code-analysis-<commit>` artifact. The existing workflow also fetches open GitHub Secret Scanning alerts, analyzes their metadata, and publishes issue comments.
