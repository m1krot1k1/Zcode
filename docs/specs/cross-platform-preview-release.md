# Cross-platform Preview release

## Product contract

The tagged GitHub Actions workflow publishes an unsigned Preview prerelease for the exact tag commit. It builds the Desktop application and standalone CLI for macOS Apple Silicon (`darwin-arm64`), Windows x64 (`win-x64`), and Linux AMD64 (`linux-x64`). Desktop uses the existing offline Preview contract: ZCode-owned backend origins resolve to unavailable loopback, ZCode telemetry and automatic updates are disabled, and no ZCode account is required. User-configured model providers and the local OpenCode CLI keep their normal behavior. The packages are Preview builds, not production builds.

Desktop outputs are macOS DMG and ZIP, Windows NSIS installer, and Linux AppImage, DEB, RPM, and pacman package. CLI outputs are standalone SEA executables for all three targets. Artifacts include the release version and platform/architecture in their names. The release is marked prerelease and its notes state that the macOS build is unsigned and may require first-launch approval.

## Ownership and sequence

The repository owns the build contract and tag/version agreement. A tag matching `vMAJOR.MINOR.PATCH` starts a workflow with read-only contents permission for build jobs; only the final publish job receives `contents: write`. Each Desktop target builds on its native runner. Each CLI target builds on a native runner and smoke-tests its executable. Build jobs upload artifacts; the publish job downloads them, validates the expected platform asset set, and creates one prerelease at the triggering tag. No workflow runs for ordinary pushes to `dev`.

The workflow does not bump versions or push commits. Before tagging, the release version in the root package manifest must match the tag. Missing signing credentials do not block Preview: macOS signing/notarization remain disabled. A failed build or missing platform output prevents publication.

## Evidence and limitations

Acceptance requires a successful Actions run for the exact tag, all three Desktop and CLI build jobs passing, expected artifacts attached to the prerelease, and the release pointing at the tagged commit. This proves builds and publication, not runtime behavior on every OS/device, Apple notarization, external provider availability, or production-backend readiness. This workflow consumes GitHub-hosted runner minutes; GitHub billing and runner availability remain external requirements.

## Acceptance scenarios

| ID | Scenario | Required result |
| --- | --- | --- |
| XPREVIEW-01 | Push a matching version tag | Exactly one tagged release workflow starts; pushes to `dev` alone do not start it. |
| XPREVIEW-02 | Build Desktop targets | macOS arm64, Windows x64, and Linux x64 each produce the formats listed above. |
| XPREVIEW-03 | Build CLI targets | macOS arm64, Windows x64, and Linux x64 standalone executables are generated and smoke-tested. |
| XPREVIEW-04 | No Apple signing credentials | Unsigned macOS Preview packages build and release notes explain first launch approval. |
| XPREVIEW-05 | Publish | One prerelease points to the exact tag commit and contains all expected versioned artifacts. |
| XPREVIEW-06 | A target fails or an artifact is missing | The publish job does not create a partial release. |
| XPREVIEW-07 | Tag and root version differ | Workflow fails before building. |
