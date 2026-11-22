# GitHub Actions billing blocker

## Symptom

A manual `workflow_dispatch` run of `.github/workflows/cross-platform-preview-release.yml` starts,
but every build job fails within 2–3 seconds with no steps and an empty runner name. The workflow is
manual-only, so a tag push, branch push, or pull request starts nothing. The check-run annotation
says:

> The job was not started because recent account payments have failed or your spending limit needs
> to be increased. Please check the 'Billing & plans' section in your settings.

## Cause

This is an account-level GitHub Actions billing/spending-limit condition. It is not a repository
build failure: the workflow never reaches checkout, setup-node, or the build steps. The release
assets for the affected version were produced locally and published manually, so the GitHub
prerelease can exist while the Actions run is red.

## Fix (account owner)

1. Open <https://github.com/settings/billing>.
2. Update the payment method and/or the Actions spending limit.
3. Re-run the failed workflow:

   ```bash
   gh run list --workflow cross-platform-preview-release.yml --limit 5
   gh run rerun <run-id>
   gh run watch <run-id>
   ```

4. Confirm the jobs now have a `runner_name` and non-empty `steps`:

   ```bash
   gh run view <run-id> --json jobs
   ```

## Scope

No repository change can enable Actions billing. The cross-platform workflow is manual-only
(`workflow_dispatch`); no push, tag push, or pull request starts it, so a tag created by the local
release does not produce failing runs. While billing is unavailable, the canonical release path is
the local macOS Preview release, built and published from the developer's Mac:

```bash
mise exec -- pnpm release:macos:preview patch
```

That script publishes the unsigned `_TEST` prerelease from the local Mac. It is not a substitute
for CI cross-platform builds: Windows/Linux installers still require the workflow and remain
unavailable until billing is restored.
