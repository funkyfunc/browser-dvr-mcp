# Releasing

Publishing is automated and tokenless. Pushing a version tag runs the tests, then
publishes to npm via **trusted publishing (OIDC)** — no npm token lives in CI.

## Cutting a release

1. Bump the version in `package.json` (e.g. `0.1.0` → `0.1.1`) and commit it to `main`.
2. Tag and push:
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```
3. The **Release** workflow runs the test job, then pauses on the `publish` job for a
   one-click manual approval (the `release` environment gate). Approve it in the
   GitHub Actions UI and npm publishes with a signed provenance attestation.

The tag must match `package.json`'s version — the workflow fails otherwise.

## One-time setup

- **npm trusted publisher:** on npmjs.com, add this GitHub repo as a trusted publisher
  for the `browser-dvr-mcp` package (Settings → Publishing access → GitHub Actions),
  pointing at `.github/workflows/release.yml`. This lets CI authenticate via OIDC with
  no token.
- **GitHub environment:** create an environment named `release` (Settings →
  Environments) and add yourself as a required reviewer, so every publish waits for a
  human "go".
- The first publish of a brand-new package name may need an initial manual
  `npm publish --access public` locally to claim the name, depending on npm's current
  trusted-publishing bootstrap rules.
