# macOS Preview prerelease without Apple signing credentials

## Product contract

An explicitly requested macOS Preview prerelease may be built on a developer's Mac and published to the existing GitHub repository without Developer ID or notarization credentials. It uses the isolated `ZCode Preview` identity and requires an explicit `ZCODE_PREVIEW_TEST_BASE_URL` pointing to an HTTPS endpoint whose normalized scheme, host, path, and query differ from the production ZCode endpoint. Missing, malformed, or production-default values stop the build before files are changed. The validated endpoint is pinned to every ZCode endpoint alias in the build environment so shell and `.env` overrides cannot redirect Preview to another endpoint. Its GitHub assets must carry the `_TEST` suffix and release notes must say that the app connects to the configured test endpoint. It must be marked as a GitHub prerelease and state clearly that Gatekeeper may block first launch until the user approves it. It must never be represented as a signed/notarized production release or overwrite the stable release channel.

## Release owner and sequence

The local release script owns version bumping, build, push, GitHub release creation, and post-publication verification. Sequence: require a clean `dev` checkout at `origin/dev` → verify the explicit test endpoint and disable signing → bump patch/minor/major → build `ZCode Preview` for current Mac architecture without signing and with the pinned test backend → verify exact app version, architecture, bundle identity, `_TEST` artifact names, archive contents, and hashes → Russian version commit → push `dev` → create a GitHub prerelease pinned to that commit → download the release files and compare hashes and tag target.

If the push succeeds but release creation or verification fails, rerun `pnpm release:macos:preview:resume <version>` with the exact version printed by the failed run. Resume requires a clean `dev` checkout whose `HEAD` equals `origin/dev`, the matching Russian Preview version commit, the same explicit test endpoint, and the already-built local assets. It never bumps or commits again. An existing tag or release is accepted only when it resolves to that exact commit; a matching existing release is reverified idempotently.

The GitHub token is used only by `gh` for the user's authorized `dev` push and prerelease creation. No Apple credentials are read, inferred, printed, or required. A failed pre-publication gate leaves no release; a failed post-publication verification reports the release URL and failed claim without claiming success.

## Evidence and limitations

The process proves that the exact commit was pushed, that the local Preview app and archives passed structural/version/architecture checks, and that downloaded release assets match local SHA-256. It does not prove Apple signing/notarization, Gatekeeper acceptance, compatibility on other Mac hardware, provider authentication, runtime quality, or PRISM self-improvement. Release notes must state the backend environment. Cross-platform installers require separate Windows/Linux builds and evidence.

## Acceptance scenarios

| ID          | Scenario                                                                                                  | Required result                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PREVIEW-01  | No Developer ID, no Apple notarization credentials                                                        | Preview build proceeds with signing disabled and does not inspect secrets.                                                                               |
| PREVIEW-01a | No explicit test endpoint, malformed endpoint, or production origin                                       | Stop before changing package.json or building.                                                                                                           |
| PREVIEW-02  | Preview artifact identity                                                                                 | App is `ZCode Preview`, bundle ID differs from stable, test backend is selected, `_TEST` asset suffix, exact version/architecture are validated.         |
| PREVIEW-03  | Archive validation                                                                                        | DMG and ZIP contain only the expected Preview app and match its payload hash.                                                                            |
| PREVIEW-04  | Release publication                                                                                       | Versioned tag targets the exact pushed `dev` commit, GitHub marks release prerelease, assets have Preview names, downloaded SHA-256 equals local output. |
| PREVIEW-05  | Invalid branch, dirty tree, stale origin, mismatched tag, malformed assets, failed build, or missing auth | Stop before publishing; do not alter `main`; do not report release success.                                                                              |
| PREVIEW-05a | Release creation fails after `dev` push                                                                   | Resume the exact pushed version commit without another version bump; reject a tag/release targeting another commit.                                      |
| PREVIEW-06  | UI/download instructions                                                                                  | Release notes identify unsigned/unnotarized status and explain first launch approval in plain language.                                                  |
