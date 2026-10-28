# Independent laboratory ownership

Forma Grand Prix lives at https://github.com/getforma-dev/forma-grandprix.
The framework remains at https://github.com/getforma-dev/forma. Competitor
applications, workloads, full measurement workflows, the control panel, reports,
cleanup and engineering history belong here. Framework unit/integration tests,
internal instrumentation and focused regression checks stay with Forma.

## Extraction provenance

The maintained laboratory was extracted from Forma commit
`29f29daec33a1e9299f462f3c3685979a0720f64`, path `benchmarks/grand-prix`.
`migration-source.json` records the original file digests before independent
development. It is a migration receipt, not a requirement that maintained code
never changes. Frozen `evidence/2026-10-24/` and historical protocols retain their
original bytes. The source history remains accessible at the exact Forma commit;
the new repository starts its own version history without importing unrelated
framework history or rewriting the old repository.

Forma's [cleanup PR #211](https://github.com/getforma-dev/forma/pull/211) merged at
`442113d9428fdde3a01dcb105d50d3b47fc9ae34`, removing the active benchmark tree and
its five workflows from the framework. The superseded in-framework laboratory
[PR #210](https://github.com/getforma-dev/forma/pull/210) and benchmark-only dependency
[PR #194](https://github.com/getforma-dev/forma/pull/194) were closed. Historical Git
commits and release evidence remain references; new benchmark development belongs
in this repository.

The engineering ledger now uses local paths in this repository. Referenced Forma
release and policy documents are retained under `provenance/forma/`, with original
paths, source revision and SHA-256 digests in `inventory.json`. The release ancestry
receipt contains original Git commit objects; tests recompute their Git object
identities and traverse the recorded parents from 3.2 to 3.1. No network request or
framework checkout is needed to review the retained decisions.

## Two independent source identities

Every new campaign must distinguish its laboratory commit from the selected Forma
commit and its contestant dependency locks. `config/laboratory.json` configures the
Forma source repository and an ignored local cache. The adapter fetches exact Git
objects and does not modify the developer’s framework working tree. Baseline
recipes remain bound to their historical source; changing competitor versions
creates a new cohort that must pass the same correctness controls.

The existing server candidate lane substitutes Rust crates with frozen compiler
and application inputs. The client lane compares published core with candidate
core. These are explicitly scoped experiments, not evidence that every package
in a coordinated current framework release was rebuilt. Preserve that distinction
in reports and add a separately versioned cohort when updating the whole stack.

## Local control, remote work

`npm start` runs a loopback-only control panel. Full campaigns execute in this
repository’s GitHub Actions. The panel can launch supported test selections,
follow runs, and retain their artifacts for local review. Local report generation,
integrity checks and prerequisite checks are lightweight; local diagnostics are
explicitly labeled and never become qualified hosted comparisons.

Original archives, raw observations, readable reports and integrity records stay
with each imported run. GitHub artifacts are temporary transport, not a permanent
archive. Sync completed runs before artifact expiry and back up the ignored `runs/`
directory. Deliberately reviewed publications use exact original ZIP release
assets and small versioned `evidence/catalog/` records with their archive digests
and source identities. Never commit generated build
trees, dependency directories, source caches or credentials.

## Coverage and claim boundaries

The server grid includes Forma, Next.js, Astro, React Router, React, Preact, Solid,
Svelte, Vue and vanilla controls across the supported Node/Bun/Deno adapters. DOM,
signals and islands use their own applicable grids. A framework absent from a
track is not a zero and not an implied loss. Angular, Nuxt, SvelteKit and Qwik do
not currently have dedicated adapters; broad coverage is not a claim to test every
major framework or every feature. Add adapters through `docs/ADAPTERS.md` with
equivalent observable work and correctness gates before making new comparisons.

The older Forma showcase dashboard is historical inspiration only. Its scores,
old framework pins and timing semantics must not silently enter current campaigns.
