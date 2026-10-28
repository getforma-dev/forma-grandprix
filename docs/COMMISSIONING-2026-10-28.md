# Independent laboratory commissioning — 2026-10-28

The client, island, paired-server and compression campaigns completed on native Linux with verified artifact integrity and qualified measurement records. The client campaign shows substantially higher Forma 3.2 fan-out throughput than its published 3.0 control, alongside remaining creation cost, engine overhead and a lower diamond-workload mean. Paired-server throughput increased; compression reduced response bytes while reducing throughput. These are workload observations, not an overall ranking or proof that a particular code change caused them.

## Evidence and scope

| Campaign | Laboratory revision | Forma under test | Evidence |
| --- | --- | --- | --- |
| Client, attempt 1 | [0904eff7](https://github.com/getforma-dev/forma-grandprix/commit/0904eff7c19100b223210e3a48ff088138fd56bd) | Published 3.0.0 control, then core built from [3.2.0 source fc76ea85](https://github.com/getforma-dev/forma/commit/fc76ea8531f0e3a85d0224087384e41f52040e3c) | [Run 40691629399](https://github.com/getforma-dev/forma-grandprix/actions/runs/40691629399) · 216 measured metric rows |
| Islands, attempt 1 | [42796d26](https://github.com/getforma-dev/forma-grandprix/commit/42796d26717dd92a6615b11e540aec3b1af29a2f) | Frozen registry adapters; **no Forma 3.2 source substitution** | [Run 40691385991](https://github.com/getforma-dev/forma-grandprix/actions/runs/40691385991) · 64 measured rows and 2 optional unavailable metrics |
| Paired server, attempt 1 | [0904eff7](https://github.com/getforma-dev/forma-grandprix/commit/0904eff7c19100b223210e3a48ff088138fd56bd) | Published 3.0.0 control, then 3.2.0 native crates in the frozen adapter | [Run 40692625222](https://github.com/getforma-dev/forma-grandprix/actions/runs/40692625222) · 62 measured rows |
| Compression, attempt 1 | [0904eff7](https://github.com/getforma-dev/forma-grandprix/commit/0904eff7c19100b223210e3a48ff088138fd56bd) | Same 3.2.0 native candidate with opt-in compression | [Run 40692665750](https://github.com/getforma-dev/forma-grandprix/actions/runs/40692665750) · 69 measured rows |

All four used the `gha-4-v1` allocation and Node 24.22.0; the browser lanes used the authenticated Chromium lock. Hosts had four available CPUs: AMD EPYC 9V74 for client, EPYC 7763 for islands and paired server, and Intel Xeon Platinum 8573C for compression. Their campaigns are separate; their times must not be combined into a cross-suite comparison. The shared test fingerprint was `a8f2f41643b44ad35c6e85886f9564a9d5997a439405634ff7898e38de92997f`.

The published client DOM cohort contains Forma, vanilla JavaScript, React, Preact, Solid, Svelte and Vue. The 3.2 candidate DOM cohort contains Forma and a concurrent vanilla control. Both source trials include the five reactive adapters and the separate Alien Signals 3.1.2 engine reference. Compiler templates and row profiling were disabled. This measures the selected core substitution in these fixtures; it is not a coordinated update of every Forma package or a survey of every framework and current release. Competitor versions remain pinned by their frozen locks.

## Client: published control and 3.2 candidate

Times and operation rates are means of **five measured repetitions after two warmups per workload**. CV is sample standard deviation divided by the mean. No samples or outliers were discarded. Changes below are `(candidate / control − 1) × 100`; higher operation rates and lower times or byte counts are preferred.

| Workload | Published 3.0 control | 3.2 candidate | Change | n, each | CV: control / candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Effect create and dispose, ops/s | 2,938,728 | 8,745,718 | +197.60% | 5 | 9.79% / 14.79% |
| Fan-out to 100 effects, ops/s | 80,699 | 211,938 | +162.63% | 5 | 8.16% / 5.91% |
| Diamond, 500 middles, ops/s | 33,978 | 32,608 | −4.03% | 5 | 3.65% / 2.25% |
| Batch of 100 writes, ops/s | 246,792 | 235,116 | −4.73% | 5 | 15.69% / 20.93% |
| Create 1,000 rows, ms | 36.60 | 36.88 | +0.77% | 5 | 17.57% / 12.82% |
| Initial JavaScript, Brotli bytes | 8,652 | 8,578 | −0.86% | 1 | not applicable |
| Initial JavaScript, gzip bytes | 9,514 | 9,410 | −1.09% | 1 | not applicable |
| Initial JavaScript, uncompressed bytes | 25,847 | 25,593 | −0.98% | 1 | not applicable |

Fan-out has a higher observed mean in this campaign, with both CVs below the report's 10% variation flag. Effect creation also has a much higher observed mean, but the candidate CV is 14.79%. Diamond is an adverse observation to investigate: its mean fell 4.03% with lower variation than the batching and DOM measurements. The batching decrease remains noisy. Neither the variation flag nor its absence is a significance test.

Creation remains a gap against the concurrent vanilla fixture: **36.88 ms versus 22.24 ms**, or **1.658×** its mean, with five repetitions each and CVs of 12.82% and 17.83%. All nine DOM source comparisons carry a greater-than-10% variation warning from at least one side. The 0.77% creation difference does not establish a source regression or improvement.

The same-version engine reference, measured in a separate sequential container, also exposes remaining costs. Forma fan-out reaches **71.61%** of Alien Signals 3.1.2's 295,981 ops/s mean; its reference CV is 8.61%. Effect creation reaches **77.63%** of the reference's 11,266,301 ops/s, but that reference is particularly noisy at 31.90% CV. Each uses five repetitions. These observations keep the historical 80% engine-relative questions open; they do not replace the original campaign's results. Vue's uncoalesced writes are excluded from equivalent-batching comparisons because its adapter has no public batch API.

Bundle sizes describe the initial static JavaScript graph, with dynamic imports excluded, compressed per measured payload and summed. They are one build observation, not five timing samples. Forma's Brotli total is 74 bytes smaller than the published control, but still **6.94×** the concurrent vanilla fixture's 1,236 bytes. This is an application-fixture cost, not a standalone library-size claim.

## Islands: frozen registry coverage

Each adapter has five independent measured browser contexts after two warmups. Readiness is the shared observable boundary. Transferred JavaScript includes response overhead and must not be equated with the client table's Brotli file sizes. The table includes every selected island adapter, rather than only favorable comparisons.

| Adapter | Readiness mean, ms | Readiness CV | Transferred JavaScript, bytes |
| --- | ---: | ---: | ---: |
| Astro | 105.42 | 14.70% | 225,827 |
| Forma | 78.96 | 5.71% | 24,016 |
| Next | 202.12 | 12.15% | 105,827 |
| Preact / Node | 38.92 | 15.61% | 13,758 |
| React / Bun | 74.60 | 3.70% | 212,399 |
| React / Deno | 100.52 | 6.85% | 223,902 |
| React / Node | 92.38 | 14.74% | 219,581 |
| React Router | 160.28 | 4.57% | 106,420 |
| Solid / Node | 35.76 | 9.70% | 12,417 |
| Svelte / Node | 47.06 | 21.86% | 28,286 |
| Vue / Node | 60.14 | 11.40% | 66,869 |

Forma's fixture transfers more JavaScript than Preact and Solid, and less than the other measured adapters, yet its readiness mean remains above Preact, Solid, Svelte, Vue and React/Bun. This suggests investigating work beyond transfer size. Forma's internal activation mean is 19.40 ms with 32.38% CV. Internal activation boundaries differ between frameworks and are not used for cross-framework ratios. Next and Astro's native activation metrics are explicitly unavailable, not zero or failed; their common readiness and interactions were measured.

## Paired server: native component substitution

The paired run replaces only `forma-ir`, `forma-ir-derive` and `forma-server` with the exact 3.2.0 source above. The benchmark application remains the frozen adapter at `3d9de62d`; its admin core, build and compiler locks remain **3.0.0**. This is a controlled native-component comparison, not a measurement of an entirely upgraded 3.2 stack.

| Measurement | Published control | 3.2 native candidate | Change | n, each | CV: control / candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100-row SSR, req/s | 1,399.44 | 1,519.38 | +8.57% | 3 | 0.21% / 0.22% |
| 1,000-row SSR, req/s | 158.14 | 173.25 | +9.55% | 3 | 1.16% / 0.85% |
| Multicore SSR, 2 CPUs, req/s | 1,763.54 | 1,868.35 | +5.94% | 3 | 0.15% / 0.16% |
| Single-request-concurrency p99, ms | 0.785 | 0.727 | −7.41% | 3 | 0.42% / 0.89% |
| Sampled container memory peak, MiB | 4.28 | 4.12 | −3.74% | 3 | 1.46% / 4.00% |
| Container launch to first page, ms | 182.70 | 185.96 | +1.78% | 5 | 3.57% / 5.18% |
| 100-row response body, bytes | 33,193 | 17,154 | −48.32% | 1 | not applicable |

Load measurements use three 10-second runs after a five-second warmup, with concurrency 64 except the concurrency-one latency event. Small CVs do not overcome the three-sample limit. The smaller response accompanies an 8.57% Sprint increase, not a proportional throughput increase. Launch time is slightly higher and includes Docker and host polling; the runtime image is also 3,288 bytes larger, at 78,190,420 bytes. Memory is sampled Docker accounting, not process RSS or a guaranteed instantaneous peak. Production build time was outside this paired selection.

## Compression: response bytes versus serving cost

Identity, Brotli and gzip used **one compression-enabled binary** in one campaign, in that order. Identity therefore includes negotiation. Each encoding's retained probe decoded to the same verified 17,154-byte body. Encoded sizes below are retained probes; the load generator's aggregate bytes per completed response matched them in all three Sprint samples.

| Encoding | Encoded body, bytes | Sprint mean, req/s | Sprint CV | Loaded p99 mean, ms | Sampled memory peak, MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Identity | 17,154 | 1,758.94 | 0.42% | 41.58 | 3.99 |
| Brotli | 2,024 | 1,112.99 | 0.28% | 63.36 | 6.92 |
| gzip | 2,195 | 1,301.96 | 0.17% | 54.74 | 4.37 |

Timings and memory use three repetitions; p99 is the mean of the three per-run percentiles at concurrency 64. Brotli reduces the probe body by **88.20%** while Sprint throughput falls **36.72%** and loaded p99 rises **52.36%**. gzip reduces bytes **87.20%**, with throughput **25.98%** lower and loaded p99 **31.65%** higher. These are same-binary tradeoffs on this host, not evidence that compression universally improves end-to-end performance. The actual gzip response is **2,195 bytes**; the separate harness gzip-level-9 diagnostic of 2,039 bytes is not the server's compressed transfer. No comparison to the paired run's identity throughput is valid across the different machines and binary configurations.

## Questions for the next controlled experiment

- Reproduce the diamond decrease while retaining the fan-out and effect improvements; inspect graph-update work before changing an optimization.
- Profile creation and readiness separately. Preserve full DOM state, keyed identity and interaction checks when evaluating a change.
- Investigate the engine-relative fan-out cost. Repeat noisy effect and batching observations under a preregistered order or counterbalanced campaign before attributing causes.
- Keep the smaller client bundle and island transfer evidence distinct from timing results and from a current 3.2 island claim.
- Test compression against an explicit bandwidth/latency constraint before changing its default; retain throughput, latency and memory costs alongside byte savings.

Client and paired-server source trials ran in a fixed order, published before candidate, within their respective hosted campaigns. The small sample sets characterize these runs, not fleet-wide behavior. There is no overall score, statistical significance claim, causal attribution, or newly adopted framework optimization in this report. Existing decisions remain in the [engineering history](PERFORMANCE-HISTORY.md); these findings supply hypotheses and future acceptance questions. The full competitor server campaign requires its own verified section.
