# Dependency maintenance — 2026-09-21

## What the install messages mean

- **`npm warn deprecated …` comes from the packages selected by the repository's
  lockfile.** npm prints the package maintainer's message when installing them
  on whichever machine runs the command. The quoted installation ran in the
  Arena sandbox, not on the owner's computer.
- These particular packages belong to **development tooling** (Mocha tests and
  Mozilla's web-ext/validator), not the browser extension's runtime. A warning
  does not mean an install failed, but unsupported dependencies deserve review.
- **“New major version of npm available” is about that machine's npm**, not an
  extension dependency. Updating a project lockfile does not update npm on
  other computers or in future sandboxes.
- **Funding is voluntary.** `--no-fund` only hides donation information; it does
  not leave software unpaid or cause deprecation warnings. The glob message
  offers optional paid support for obsolete versions. No payment is necessary
  to use updated open-source packages, and no money was spent here.

## Changes made

Both maintained projects, `NHDW_Extension_v3.0.0/` and `NHDW_Firefox_v1.0.0/`:

- Mocha **11.8.0 → 12.0.2** (manifest now `^12.0.2`). This removes the old glob
  dependency and updates its affected test-runner dependencies.
- Refresh the existing transitive **fast-uri to 3.1.8** within its allowed
  version range, resolving the reported advisories.
- Declare the tools' Node requirement: **`^20.19.0 || ^22.13.0 || >=24.0.0`**.
  Prefer a maintained Node 22/24 LTS installation; Node 18 is no longer enough.
- Regenerate lockfiles, retaining **lockfileVersion 3** and npm 10 compatibility.

Firefox additionally:

- web-ext **8.10.0 → 10.6.0** (manifest now `^10.6.0`). Its updated dependency
  tree removes the old rimraf/inflight, glob 7, uuid 8 and ESLint 8 chains.
- A **scoped override** selects `web-ext > addons-linter` **10.13.0**. web-ext
  10.6.0 pins 10.10.0, whose image-size dependency is still affected by reported
  advisories. 10.13.0 contains the patched version. This stays within the same
  linter major, and both real-extension linting and safe/unsafe fixture scans
  were checked. Remove/reassess this override when web-ext's own dependency
  advances to a patched validator; do not let this pin freeze it indefinitely.

The sandbox's npm was updated **10.9.8 → 12.0.2** on Node **22.22.3**. This is
an environment change, not a repository-installed dependency. npm 12 itself
requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, stricter than the project:
check `node --version` / `npm view npm@12.0.2 engines` before upgrading npm on
another machine. Updating npm is not necessary just to run the extension.

## Verified results

| Check | Chrome build | Firefox build |
|---|---:|---:|
| Full dependency audit findings, before → after | **5 → 0** | **16 → 0** |
| Runtime-only audit findings | **0** | **0** |
| Fresh-install deprecation warnings | **0** | **2**, described below |
| Unit tests | **398 pass / 4 pending** | **431 pass / 4 pending** |
| Build, smoke, complete offline e2e | Pass | Pass, including 33 options tests |

Fresh `npm ci --no-fund` succeeds with **both npm 10.9.8 and npm 12.0.2**;
`npm ls --all` reports a valid tree. Firefox validator: **0 errors / 0 notices /
30 existing advisory warnings**, a separate result from npm's install warnings.
A safe fixture has no findings; deliberately unsafe innerHTML/eval fixtures
still produce `UNSAFE_VAR_ASSIGNMENT` and `DANGEROUS_EVAL`. Unsigned 1.2.0
packaging was rechecked; no browser/device or signing claim is made.

**All runtime dependency versions/integrities and rebuilt extension bundles
are unchanged by this maintenance.** Prior PR #44 review / options fixes are
preserved. No extension source, manifest, feature, release snapshot or CI
workflow changes. The inactive historical `NHDW_Source_v3.0.0/` snapshot is not
part of these results and was not rewritten; installing its old lockfile can
still report outdated dependencies.

Audits are a point-in-time check of published advisories, not a guarantee that
all vulnerabilities have been discovered.

## Two Firefox warnings still depend on upstream work

1. `web-ext → addons-linter@10.13.0 → eslint@9.39.4`. The current Mozilla
   validator explicitly uses `Linter({configType: 'eslintrc'})`, `defineRule`
   and `defineParser`. ESLint 10 removed this legacy API. Forcing ESLint 10
   would break the validator; even the newer 9.39.5 maintenance patch is
   deprecated. Leave this visible until Mozilla migrates the validator.
2. `addons-linter → cheerio@1.2.0 → encoding-sniffer@0.2.1 → whatwg-encoding@3.1.1`.
   Current Cheerio still declares the older codec. Its replacement parent
   release, encoding-sniffer 1.x, is an ESM-only breaking release outside
   Cheerio's declared range. No out-of-range codec override was forced merely
   to silence a warning.

**These warnings have not been hidden or falsely reported as fixed.** No
`npm audit fix --force`, deprecation-warning suppression, validator removal or third-party
validator fork was used. Future upstream updates should be checked with the
same build/tests/lint rather than blindly overriding transitive major versions.

## Recheck later

In each maintained build folder:

```sh
npm ci --no-fund
npm audit
npm audit --omit=dev
npm run build
npm test
npm run test:smoke
npm run test:e2e
# Firefox only:
npm run lint:firefox
npm run package:firefox
```

`npm outdated` is useful for planning updates, not a reason to upgrade every
package to its newest major. `npm fund` lists voluntary sponsorship links;
it does not fix warnings or initiate a payment.
