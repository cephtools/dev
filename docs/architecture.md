# Architecture decisions

**Static site + scheduled collector, no server.** GitHub Actions collects and scores, GitHub Pages serves
static JSON and plain HTML/CSS/JS. Nothing to operate, no secrets in the browser, free.

**GraphQL, not REST.** One aliased GraphQL query returns comments, reviews (with inline-comment counts),
commits, force-push events, files and CI state for 10 PRs at about 1 point. The REST equivalent needs
6+ requests per PR (~10k requests for ceph/ceph's ~1,800 open PRs), far beyond `GITHUB_TOKEN`'s budget.

**Incremental collection.** Every run lists all open PRs (cheap, ~19 requests) so the open set is always
complete, then fetches details only for PRs that are new, whose `updatedAt` changed, or whose details are
older than 48h. The per-PR cache also accumulates events beyond GitHub's 100-per-connection limit.
A rate-limit reserve and a per-run cap bound the cost; leftover work rolls over to the next run.

**State on a data branch.** `cache.json`, `history.json` and the published data live on `dashboard-data`
as a single force-pushed orphan commit: durable (unlike the Actions cache, which is evicted), inspectable,
and it does not grow the repository.

**Events, not snapshots, for recency and acceleration.** Every comment, review and push carries its own
timestamp, so recent-versus-earlier activity is measured from real event times, not inferred by diffing
snapshots. Snapshots (history.json) are used only for rank movement. Where event history is incomplete,
the score says so and does not apply acceleration.

**Two independent scores.** Trending uses only activity; technical importance uses only changed paths,
labels and text. A test asserts that adding 80 comments to a PR leaves its technical score unchanged.

**Rules as data.** Classification rules live in `config/subsystems.json` so Ceph developers can adjust them
without touching code. Every score is returned with its evidence and shown in the UI. An LLM classifier
could be added later as an optional extra evidence source, but the dashboard does not need one.

**One data contract.** `schema/dataset.schema.json` is validated at publish time, again before deploy,
and in tests. The manifest/dataset split with versioned file names makes publishing atomic and lets the
frontend detect schema changes.

**Fail loudly, degrade gracefully.** A failed listing aborts the run (never publish an empty or truncated
list); per-PR failures and budget exhaustion produce a partial dataset with explicit notes. The last good
dataset stays online with a failure banner.

**Minimal stack.** Node ≥ 22.18 runs TypeScript directly; the frontend is plain ES modules. Zero runtime
dependencies; dev dependencies are only `typescript` and `@types/node`.
