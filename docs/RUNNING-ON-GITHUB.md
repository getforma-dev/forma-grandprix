# Run Grand Prix on GitHub Actions

Use hosted Ubuntu as the routine qualification environment and a Mac for local
correctness/debugging. Both environments can run Docker; on macOS Docker runs
inside Docker Desktop's Linux VM. Do not combine Mac ARM observations with Linux
x64 results or claim that the change in machine proves a framework improvement.

GitHub standard Ubuntu runners for this public repository currently provide four
vCPUs and 16 GB RAM. They are virtual machines, not dedicated physical machines.
The reviewed `gha-4-v1` protocol records actual CPU affinity and separates the
server/load generator allocations. It intentionally differs from `native-8-v1`.
For more precise long-term measurements, a quiet dedicated Linux host with fixed
hardware is a separate useful profile; Actions remains useful for orchestration.

References: [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [Docker Desktop's Mac VM](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/#containers-running-as-root-within-the-linux-vm).
Specs checked 2026-10-28; actual runner metadata and profile validation are authoritative.

## Qualified hosted inputs

Choose the exact reviewed branch in **Actions → workflow → Run workflow**. Use
`runner=ubuntu-24.04`, `profile=gha-4-v1`, and `diagnostic=false`. Pinning the Ubuntu
release avoids the `ubuntu-latest` alias moving to a different OS release; GitHub
still updates that image and the host hardware may vary. Preserve those identities.

| Purpose | Existing workflow | Additional inputs |
| --- | --- | --- |
| Full server comparison | `grand-prix.yml` | `cars=all`, `events=1-8`; exact `forma_ref` if testing candidate Rust crates |
| Controlled server before/after | `grand-prix-paired.yml` | `forma_refs` = exact candidate commits, comma-separated |
| DOM, bundle and reactive cores | `grand-prix-client.yml` | `forma_refs` = exact candidates; `profile_rows=false`, `compiler_templates=false` for the default core |
| Native activation/islands | `grand-prix-islands.yml` | Default complete entrant set |
| Explicit compression experiment | `grand-prix-compression.yml` | Exact candidate source; keep this distinct from identity-response tests |

Forma 3.2.0's registered source is
`fc76ea8531f0e3a85d0224087384e41f52040e3c`. Inspect the current ledger and candidate
configuration before selecting it. Server source replacement is a controlled
Rust-component experiment with frozen compiler/app inputs, not a complete new
all-package stack cohort. Related package and crate updates need coordinated locks.

Every before/after pair runs sequentially within one job/VM. Do not compare a
candidate from today's VM directly with last week's baseline as a causal speedup.
Rerun the control beside it. Keep different campaigns and resource profiles visible.
No concurrent builds/installations may overlap timing within the measurement host.

## Independent workflows and the control panel

All five measurement workflows live in `getforma-dev/forma-grandprix`. They run
only after an explicit dispatch; ordinary pushes and PRs run the laboratory's unit
and refusal controls. A green software check is not a measured performance result.
The measurement defaults are `ubuntu-24.04`, `gha-4-v1`, and `diagnostic=false`.
A qualified campaign must still pass source, transport, correctness, browser and
CPU-allocation checks. Missing or incompatible evidence stays unqualified.

Run `npm start` locally, then open http://127.0.0.1:4317. Choose the suite and its
supported test selection, review the exact Forma revision, and launch the remote
run. GitHub authentication is provided by the local `gh` CLI; credentials never
enter browser JavaScript. Test execution happens on GitHub. The panel shows remote
progress and provides artifact synchronization into the local evidence history.

Server tests support entrant and event selection. The client suite retains its
paired complete grid because filtering it would change that campaign contract.
Islands use their frozen registry cohort. They currently do not substitute the
selected Forma source candidate. The panel must display this boundary rather than
present frozen package observations as current release measurements.

## Keep readable, durable results

Each attempted workflow starts an evidence record before dependency installation.
The runner captures process logs, raw measurements, exact run/attempt and source
identities, cleanup receipts, and HTML/Markdown/CSV/JSON reports. Finalization and
artifact upload run on failures too. Failed attempts and unavailable measurements
remain visible. Workflow completion alone never establishes qualification.

Use the control panel to sync completed artifacts and verify the imported run.
Original archive digests and remote identities stay with the local record. The
panel's report and evidence links read this retained copy; they do not depend on
expiring download URLs. Report regeneration is a derived view, not a new campaign.

Artifacts expire after **30 days**. Sync before expiry and back up `runs/`; local
run history is deliberately ignored by Git. Review `npm run gp -- archive RUN_ID`,
then add `--publish` to preserve the exact ZIP as a durable GitHub release asset.
Commit the small `evidence/catalog/` record, which binds its digest and source
references to the original outcome. Keep the before/after rationale and accepted
costs in `config/change-ledger.json`. Do not overwrite historical controls.

Performance targets and measurement validity are separate. A complete server
campaign can retain qualified evidence while failing CI for a missed target, but
only when its authenticated execution record proves that the target miss was the
sole failure. Missing measurements, source changes, failed correctness or cleanup
still prevent qualification. Older attempts retain their original classifications.

Cleanup remains run-owned. Disposable dependency/build output is removed before
publication; original observations, source and lock identities, logs, readable
reports and integrity receipts remain. Never globally prune Docker or delete
another job's resources.
