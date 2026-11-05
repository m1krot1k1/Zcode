# GitHub Actions billing blocker

## Symptom

A preview tag push starts `.github/workflows/cross-platform-preview-release.yml`, but every build
job fails within 2–3 seconds with no steps and an empty runner name. The check-run annotation says:

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

No repository change can enable Actions billing. Until the account is fixed, the supported preview
release path remains the local script:

```bash
mise exec -- pnpm release:macos:preview patch
```

That script publishes the unsigned `_TEST` prerelease from the local Mac. It is not a substitute
for CI cross-platform builds (Windows/Linux installers still require the workflow).
