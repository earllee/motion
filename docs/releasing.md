# Releasing

The **Release** workflow (`.github/workflows/release.yml`) cuts releases from `main`:

- **Nightly** at 08:00 UTC (midnight Pacific), if anything landed on `main` since the last `v*` tag. Quiet nights are skipped.
- **On demand** from Actions → Release → Run workflow. Pick a `patch`, `minor` or `major` bump, and tick *force* to release even with nothing new.

Each run bumps the patch version from the last tag (`v0.1.2` → `v0.1.3`), runs typecheck and tests, builds Apple Silicon and Intel DMGs and zips with `scripts/release.sh`, signs and notarizes them, and publishes a GitHub release with `latest-mac.yml`, which is what installed copies check for updates. The version is set at build time and not committed; to jump to a bigger version, either pick `minor`/`major` when running it by hand or raise `version` in `package.json`, which wins when it is ahead of the last tag.

Release notes list the merged PRs (GitHub's "What's Changed"), any commits pushed straight to `main`, download links and SHA-256 checksums. Edit the release on GitHub afterwards to add a written summary.

## Secrets

Add these under Settings → Secrets and variables → Actions:

| Secret | What it is |
| --- | --- |
| `MAC_CERT_P12_BASE64` | The "Developer ID Application: Earl Lee (29RGKF5J9D)" certificate with its private key, exported from Keychain Access as a .p12, then `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | The password you set when exporting the .p12 |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from account.apple.com → Sign-In and Security |
| `APPLE_TEAM_ID` | `29RGKF5J9D` |

The workflow stops before building if any are missing.

## By hand

`npm run release` still works on a Mac with the certificate in the login keychain and a `motion-notary` notarytool profile (see the top of `scripts/release.sh`). Set `version` in `package.json` first, then attach `release/*.dmg`, `*.zip`, `*.blockmap` and `latest-mac.yml` to a new release.
