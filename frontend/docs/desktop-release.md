# Desktop release runbook

How to cut a stable desktop release, end to end. Written from the v0.10.3 cut
(2026-07-12), which bumps the version on `main` via a PR and tags the merge
commit. v0.10.1/v0.10.2 used an older tag-only stamp commit that never landed
on `main`; the PR-based flow below supersedes it.

## How releases work

- **Stable** releases are triggered by pushing a `desktop-vX.Y.Z` tag to
  `AgentWrapper/agent-orchestrator`. `.github/workflows/frontend-release.yml`
  builds on four runners (macOS arm64, macOS Intel, Windows, Linux), signs and
  notarizes the macOS builds, and publishes a GitHub Release.
- **Nightly** releases run on a schedule via `frontend-nightly.yml` with no
  manual steps. The nightly version is derived from the highest `desktop-v*`
  stable tag (next patch + `-nightly.<timestamp>`), so after `desktop-v0.10.2`
  nightlies become `v0.10.3-nightly.*`.
- The version source of truth is `frontend/package.json` `"version"`.
  electron-forge's GitHub publisher names the release `v<package.json version>`,
  NOT after the git tag. The `desktop-v*` tag is only the workflow trigger, so
  the tagged commit must carry the right version (see the stamp commit below).
- The bump lands on `main` via a PR, so `main`'s `frontend/package.json`
  tracks the last released version; the `desktop-v*` tag then points at that
  merge commit. Nightlies stamp the version at build time from the highest
  `desktop-v*` tag, so they are unaffected by whatever `main` currently carries.
- macOS and Linux packages build and ship a pinned tmux under
  `resources/tmux/bin/tmux`. Before spawning the daemon, Electron atomically
  stages that binary in versioned storage under the AO data directory; this
  keeps it available after a Linux AppImage mount disappears. The daemon
  derives an explicit AO-private `tmux -S` socket from its run-file identity and
  starts tmux without reading the user's tmux configuration. New sessions never
  leave that socket. For updates or downgrades involving older handles, the
  daemon scans the historical named `-L ao`, system-default, and private sockets.
  It routes an existing session only when its immutable pane command proves the
  same AO run-file, session id, supervised marker, and launch generation, then
  persists a namespace-qualified handle and repairs stale lifecycle facts.
  Multiple owned matches require explicit recovery; a same-named user session
  is never adopted. Older adapters reject the qualified handle instead of
  treating it as a bare tmux name, which makes later downgrades fail closed.
  Socket inodes remain in AO state;
  a bounded owner-only `/tmp` directory alias handles deeply nested paths on
  macOS, and unsafe shared-writable socket directories fail closed. Pane
  environments are applied over stdin before the real command starts, keeping
  configured values out of process arguments. Windows uses ConPTY and carries
  no tmux resource.

## Hard rule: exactly one publisher

**Only the designated release conductor runs a real publish.** There is no ad
hoc human-triggered publish outside that identity, on any channel, for any
reason, including "just this once to test something".

Why this is a rule and not a preference: between 22 and 24 Jul two different
publishers emitted divergent macOS zip formats on alternating days. When the
28-29 Jul signing incident hit, the evidence was unreadable, because builds
differed for reasons that had nothing to do with the bug being investigated.
Two days were spent chasing a false "the signing pipeline corrupts the seal"
conclusion that a hand-run `unzip` had manufactured. A single publisher makes
consecutive releases byte-comparable, so a real regression shows up as a real
difference.

What this means in practice:

- The release conductor identity owns every publish that produces a
  user-facing artifact: stable, nightly, and feature releases.
- Approving a release run is a different act from publishing one. Any approver
  on the list below can approve; only the conductor triggers.
- If you need a build to test something, cut it on the fork dev loop (see
  "Fork test releases" below). Never on the canonical repo.
- If the conductor is unavailable, hand the role over explicitly and record the
  handover. Do not publish "on their behalf" from a second identity.
- If two artifacts for the same version ever exist and differ, treat every
  conclusion drawn from either one as void until the divergence is explained.

Verification of artifacts is a separate concern and is not owned by any single
identity: anyone can and should run
`frontend/scripts/verify-mac-artifact.sh <artifact>`, which is the only
supported way to check a macOS artifact by hand. Do not type the checks out
manually; that is how the 28-29 Jul misdiagnosis happened.

## Re-enabling updater feeds after a runtime safety containment

Withdrawing updater manifests is a fail-closed containment tool, not a release
rollback. If stable or nightly feeds have been disabled because an update or
downgrade could duplicate a session controller, keep every affected feed
disabled until all gates below pass. Existing tags, installers, and historical
release entries remain forensic evidence. **Never restore a withdrawn old
manifest:** it still selects the unsafe artifact. Re-enable a channel only by
publishing fresh manifests that select one newly verified release.

The sole release conductor owns the feed mutation. Code authors and test
operators may prepare artifacts and evidence but must not add, delete, or
replace manifests while the containment is active.

### 1. Candidate provenance and CI

- The candidate contains the reviewed runtime-provenance fix, including
  namespace-qualified handles, ownership-gated legacy adoption, ambiguous-owner
  rejection, and a pre-respawn live-controller fence.
- Required review is complete and every required CI job passes, including the
  full race-enabled backend suite and desktop tests.
- Candidate installers are produced once by the designated conductor from the
  reviewed commit. The packaged daemon's version/build metadata resolves to
  that exact commit on every platform; no locally rebuilt daemon is substituted.
- macOS zip and dmg artifacts pass
  `frontend/scripts/verify-mac-artifact.sh`. The ordinary Windows and Linux
  signing/package checks also pass before runtime testing begins.

### 2. Disposable update and downgrade matrix

Run this matrix only with copied fixture data and isolated `AO_DATA_DIR`,
`AO_RUN_FILE`, and `TMUX_TMPDIR` values. Do not point a candidate at a user's
live database, worktrees, tmux servers, agent homes, or native thread files.
Capture database rows, tmux server/socket identity, pane PID/start command, AO
supervisor PID/generation, and native-agent PID before and after every case.

- **Historical default -> candidate:** a uniquely AO-owned session on the
  system-default server is adopted without pane restart, input, resize, or
  process replacement. Its durable handle becomes qualified as `default`, its
  live launch generation is repaired, and a false `exited` activity becomes
  `idle` only when the exact supervised workload is alive.
- **Historical named -> candidate:** the same assertions pass for the legacy
  named `-L ao` server, with a qualified `named` handle.
- **Private -> candidate restart:** a private-socket session remains on the
  same socket with the same controller/process chain and a qualified `private`
  handle across two desktop restarts.
- **Clean candidate spawn:** a new session exists only on the run-file-derived
  private socket and survives attach, output, input, ordinary exit, and a safe
  resume without appearing in either legacy server.
- **Owned ambiguity:** the same AO session name and valid ownership stamp in
  any two, then all three, namespaces produces
  `RUNTIME_OWNERSHIP_AMBIGUOUS`. No candidate pane, process, durable generation,
  worktree, or native thread is changed.
- **Foreign collision:** a same-named user tmux session is never adopted or
  mutated. A foreign match cannot be converted into `exited` or used as a
  resume target.
- **Stale durable launch:** when the database generation differs from a live AO
  supervisor, resume returns `RUNTIME_CONTROLLER_ACTIVE` before
  `respawn-pane`, child launch, or generation writes. Repeat with the activity
  row already marked `exited`.
- **Candidate -> old build downgrade:** a namespace-qualified handle is
  rejected by each supported older packaged adapter. The old build may report
  recovery-required/inconclusive, but it must not create a tmux session,
  respawn a pane, start a second supervisor/native writer, or rewrite the
  qualified handle. Test both ordinary startup and an attempted Resume.
- **Active native writer:** using a disposable native-agent home and thread,
  keep one controller live and attempt a second restore. AO must reject before
  a duplicate controller is launched; the canonical writer and rollout remain
  unchanged, and the client receives a structured conflict rather than a
  successful Resume followed only by terminal stderr.
- **Windows control:** ConPTY create, attach, exit, and resume smoke tests pass;
  tmux-qualified handles and Unix compatibility scanning are never selected.

Every case must pass with zero unexplained PID, start-command, socket, handle,
or lifecycle changes. An inconclusive probe is a failed release gate unless the
expected outcome for that case is an explicit, non-mutating recovery-required
result.

### 3. Fresh-feed verification

- Build and exercise the candidate through the fork/dev release loop while the
  canonical stable and nightly feeds still have zero public candidates.
- Generate fresh stable/nightly manifests from the verified candidate
  artifacts only. Their version, checksum, size, and platform/architecture
  targets must match the assets tested above.
- Before making a feed public, inventory GitHub's release API, Atom output, and
  the shipped resolver's complete fallback window. There must be no older
  manifest that a client can select after skipping the new release.
- After publication, verify authenticated and unauthenticated API responses,
  Atom, `/releases/latest`, and direct macOS/Linux/Windows manifest URLs all
  select the exact verified tag and commit. Stable must not resolve to nightly;
  nightly must not fall back to a historical release.
- Canary one real update from the last supported stable and one from the last
  supported nightly on each desktop platform, then rerun the session/runtime
  invariants above. Stop and withdraw only the new manifests if any invariant
  fails; preserve the candidate release and artifacts for diagnosis.

Record the tested artifact digests, source commit, complete matrix results,
feed inventory, selected tag per platform/channel, conductor identity, and
timestamps in the incident issue before declaring either channel restored.

## Prerequisites

- Push access to `AgentWrapper/agent-orchestrator` (the tag push is the trigger).
- Authenticated `gh` CLI for the notes/verify steps.
- A release approver available (see "Who can approve" below); the build jobs
  wait on the `release` environment until someone approves.
- Repository variable `VITE_WORKOS_CLIENT_ID` set to the public AuthKit client
  ID. Release and artifact workflows fail before packaging when it is absent,
  rather than silently shipping a desktop build with sign-in disabled.

## Cutting a stable release

Throughout, `X.Y.Z` is the new version (e.g. `0.10.2`) and `upstream` is the
`AgentWrapper/agent-orchestrator` remote.

### 1. Decide the version and review what ships

```bash
git fetch upstream main
# last stable tag reachable from main:
git tag --merged upstream/main --sort=-creatordate | grep -Ev 'nightly|desktop' | head -1
# commits that will ship:
git log v<last-stable>..upstream/main --oneline
```

Stable versions bump the patch unless something warrants minor/major.

### 2. Bump the version on `main` via a PR

Bump `frontend/package.json` to `X.Y.Z` on a branch and merge it into `main`.
This is the only version pin the stable build reads; `packages/ao*` are not
gated on the desktop release and stay as-is.

```bash
git checkout -b release-X.Y.Z upstream/main
# edit frontend/package.json: "version": "X.Y.Z"
git add frontend/package.json
git commit -m "chore(release): stamp desktop app version X.Y.Z"
git push <your-remote> release-X.Y.Z
gh pr create -R AgentWrapper/agent-orchestrator --base main \
  --head <owner>:release-X.Y.Z \
  --title "chore(release): stamp desktop app version X.Y.Z"
```

Merge the PR into `main` once it is green.

### 3. Tag the merge commit and push (this triggers the release)

Tag the merged `main` HEAD; confirm it carries the right version first, since
the release name comes from `frontend/package.json`, not the tag.

```bash
git fetch upstream main
git show upstream/main:frontend/package.json | grep '"version"'   # must read X.Y.Z
git tag -a desktop-vX.Y.Z upstream/main -m "Desktop release X.Y.Z: <highlights with PR numbers>"
git push upstream desktop-vX.Y.Z
```

### 4. Approve the `release` environment

The run appears under Actions > "Desktop release" in `waiting` state. An
approver either clicks "Review deployments" > approve in the run page, or from
the CLI:

```bash
run_id=$(gh run list -R AgentWrapper/agent-orchestrator --workflow frontend-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh api repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  --jq '.[] | {env: .environment.id, can_approve: .current_user_can_approve}'
gh api -X POST repos/AgentWrapper/agent-orchestrator/actions/runs/$run_id/pending_deployments \
  -F 'environment_ids[]=<env id from above>' -f state=approved -f comment='Release X.Y.Z approved'
```

Then wait (roughly 30 minutes; macOS notarization dominates):

```bash
gh run watch $run_id -R AgentWrapper/agent-orchestrator --exit-status --interval 60
```

The workflow retries transient macOS sign/notary flakes on its own. The
release publishes as non-draft, non-prerelease automatically (`draft: false`
in `forge.config.ts`), so it becomes `latest` as soon as publish succeeds.

### 5. Attach release notes

The publisher creates the release with an empty body. Generate the standard
What's Changed / New Contributors / Full Changelog body and attach it:

```bash
gh api repos/AgentWrapper/agent-orchestrator/releases/generate-notes \
  -f tag_name=vX.Y.Z -f previous_tag_name=v<last-stable> --jq '.body' > /tmp/notes.md
gh release edit vX.Y.Z -R AgentWrapper/agent-orchestrator --notes-file /tmp/notes.md
```

### 6. Verify

```bash
# published, not draft/prerelease, 17 assets:
gh release view vX.Y.Z -R AgentWrapper/agent-orchestrator \
  --json isDraft,isPrerelease,assets --jq '{isDraft,isPrerelease,count:(.assets|length)}'
# latest points at the new release:
gh api repos/AgentWrapper/agent-orchestrator/releases/latest --jq '.tag_name'
# updater feed carries the new version:
curl -sL https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/latest-mac.yml | head -3
```

Verify the macOS artifacts with the shared script rather than by hand:

```bash
gh release download vX.Y.Z -R AgentWrapper/agent-orchestrator \
  --pattern 'agent-orchestrator-darwin-*.zip' --dir /tmp/relcheck
frontend/scripts/verify-mac-artifact.sh /tmp/relcheck/agent-orchestrator-darwin-arm64.zip
```

It extracts with `ditto -x -k` (plain `unzip` breaks the seal and produces a
convincing false failure) and runs `codesign --verify --deep --strict`,
`spctl -a -vv -t exec` and `xcrun stapler validate`.

Expected assets: versioned installers for every platform
(`Agent.Orchestrator-darwin-{arm64,x64}-X.Y.Z.zip`, `Agent.Orchestrator.Setup.X.Y.Z.exe`,
`Agent.Orchestrator-X.Y.Z.AppImage`, deb, rpm) plus `.blockmap` sidecars for
Windows and Linux only (macOS ships none by policy since #3151, so mac clients
always take the full-download path), the version-free aliases `ao start` fetches
(`agent-orchestrator-darwin-arm64.zip`, `agent-orchestrator-darwin-x64.zip`,
`agent-orchestrator-win32-x64.exe`, `agent-orchestrator-linux-x64.AppImage`,
and the deb/rpm published under versioned names), and the electron-updater
feeds `latest.yml`, `latest-mac.yml`, `latest-linux.yml`.

**Stable releases only** additionally carry
`agent-orchestrator-darwin-{arm64,x64}.dmg` for first install, and this is the
artifact the download page and the README tables link to. Mounting it gives the
drag-to-Applications window, so the app lands in `/Applications` rather than
being unzipped into `~/Downloads` and launched from there (#3617, #3527).

It is not built here. The release conductor assembles it around the app it has
already signed and stapled, then signs, notarizes and staples the container
separately, because an app's ticket does not propagate outward: a signed but
unnotarized dmg is rejected with `source=Unnotarized Developer ID`. Building the
image before the app is stapled would leave the nested bundle without a ticket,
so the conductor's verification gate mounts the finished dmg and validates the
`.app` inside it.

Nightly and preview channels do not build one. The container costs a second
notarization submission per architecture, and those channels publish far too
often to pay for it; their users update in-app and never need a first-install
container.

The dmg is purely additive: `MacUpdater` can only install an update from a zip
(`findFile(files, "zip", ["pkg", "dmg"])`), so the macOS zip and
`latest-mac.yml` keep publishing permanently, and the dmg is deliberately absent
from the feed manifests. See issue #3267 for the rollout order.

If a platform leg fails, re-run the failed jobs from the Actions UI; the
stable-alias upload steps use `--clobber`, so re-runs replace assets safely.

## Who can approve releases

Approval is governed by required reviewers on the `release` environment
(repo Settings > Environments > release). As of 2026-07-04 the approvers are:

- @harshitsinghbhandari
- @neversettle17-101
- @somewherelostt
- @Vaibhaav-Tiwari
- @Priyanchew

Anyone with write access can push the `desktop-v*` tag, but the build jobs
stay in `waiting` until one of the approvers above approves the run, so only
they can actually cut a release through the workflow. Self-review is allowed,
meaning a tag pusher who is also an approver may approve their own run; a
pusher who is not an approver still needs one of the five. Repo admins can
bypass the gate. The current list is readable by anyone with repo access:

```bash
gh api repos/AgentWrapper/agent-orchestrator/environments/release \
  --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'
```

## Fork test releases (dev loop)

Test releases go to the fork, never to AgentWrapper: push a `desktop-v*` tag
to the fork or run the workflow via `workflow_dispatch` from the fork's
Actions tab. `AO_RELEASE_REPO` is derived from `github.repository`, so a fork
run publishes to the fork with no source edit. See the header comment in
`frontend-release.yml`.

## Signing infrastructure (reference)

macOS signing + notarization is driven by repo Actions secrets consumed by
`.github/actions/macos-signing-setup`: `CSC_LINK` (base64 `.p12`),
`CSC_KEY_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and the notarytool API key trio
`APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. These are
configured; releases since v0.10.1 ship signed and notarized, and the in-app
auto-updater (`update-electron-app` in `src/main.ts`, active only when
`app.isPackaged`) updates installed apps from the Releases feed. Windows
code-signing is still a follow-up (issue #401).

---

## Feature releases

A **feature release** is a signed, installable build of a single **unmerged** PR, cut
manually so the PR can be dogfooded or demoed in isolation. It is not for merged PRs
(nightly already covers those). The build ships as a GitHub prerelease on an isolated
`pr<N>` update channel and is exposed in-app as a third channel alongside Stable and
Nightly.

### What it is and when to cut one

|                       |                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Use when**          | You want to share or test a specific PR before it merges, without pulling in the rest of nightly.                                                                                                                                  |
| **Do not use when**   | The PR is already merged (nightly covers it), or you want an automated regular build.                                                                                                                                              |
| **Channel isolation** | Builds publish to the `pr<N>` electron-updater channel only. `latest*.yml` and `nightly*.yml` manifests are never written (enforced by a channel-assertion guard in the workflow). Stable and nightly auto-updates are unaffected. |

### Cutting a build

1. Go to **Actions > Desktop feature release** and click **Run workflow**.
2. Fill in the inputs:

   | Input        | Required | Description                                                                        |
   | ------------ | -------- | ---------------------------------------------------------------------------------- |
   | `pr`         | Yes      | PR number to build. Must be open at dispatch time.                                 |
   | `slug`       | No       | Short display label (e.g. `fix-crash`). Display-only; never in the version or tag. |
   | `platforms`  | No       | Comma-separated: `mac,win,linux` (default: all three).                             |
   | `allow_fork` | No       | Set to `true` to build a cross-repository (fork) PR. Off by default.               |

3. Dispatch the workflow. A `guard` job runs first (no secrets, inspectable) and:
   - Fails fast if 5 feature releases are already active ("retire one first").
   - Confirms the PR is open; rejects fork PRs unless `allow_fork=true`.
   - Computes the version: `<base>-pr<N>.<UTCts>+<sha>` (tag: `v<base>-pr<N>.<ts>`).

4. The `release` and `release-intel` build jobs then pause for **environment approval**
   (the same `release` environment required-reviewer gate as the stable release). An
   approver must click **Approve and deploy** in the GitHub UI.

   **Security rule: the approver must inspect the PR's head SHA before approving.**
   These jobs check out and build unmerged code with access to the signing secrets
   (`CSC_LINK`, `CSC_KEY_PASSWORD`, Apple notarization keys). Every dispatch is a
   fresh approval. Fork PRs carry extra risk and require `allow_fork=true` to even
   reach this gate.

5. After approval the build runs: sign + notarize (macOS, with a 3x retry for
   transient Apple notary flakes), publish prerelease, write the `pr<N>` feed files
   (`pr<N>.yml`, `pr<N>-mac.yml`, `pr<N>-linux.yml`), and annotate the release with
   the machine-readable marker:
   ```
   <!-- ao-feature-build: {"pr":<N>,"base":"<base>","sha":"<sha>","slug":"<slug>"} -->
   ```
   The release name is set to `[feature] PR #<N>: <title>`.

### One live build per PR and the version/identity scheme

- **One live build per PR:** before publishing, the workflow deletes any existing
  `v*-pr<N>.*` prerelease for the same PR number. A rebuild of the same PR replaces
  the old build and resets the 7-day expiry timer. The approver re-vets the new head
  SHA on every rebuild.
- **Version format:** `v<base>-pr<N>.<UTCts>` (build metadata `+<sha>` is stripped for
  the tag). Example: `v0.2.0-pr2270.202507061200`. The semver prerelease identifier
  `pr<N>` is the electron-updater channel key; it must match exactly, which is why the
  `slug` is display-only and never appears in the version or tag.

### Lifecycle and limits

| Scenario                        | Behavior                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| New build cut for same PR       | Prior build deleted first; 7-day timer resets; approver re-vets new SHA.              |
| 5 feature releases already live | Workflow fails at `guard`; retire one before cutting a new build.                     |
| PR closed or merged             | Immediate cleanup via `feature-release-cleanup.yml` (`pull_request: closed` trigger). |
| Build reaches 7 days old        | Daily cron sweep (`feature-release-cleanup.yml` `schedule` trigger) deletes it.       |

The cleanup workflow (`feature-release-cleanup.yml`) runs with `contents: write` only,
no environment gate (no secrets needed for deletion).

### How users consume feature releases

Feature Releases is gated behind **Developer Mode** (off by default). Enable it first
under **Settings > Developer Mode**; the **Feature Releases** channel option only
appears while Developer Mode is on. Users then install and track a feature build from
**Settings > Updates**:

1. Change the primary channel to **Feature Releases**. A second dropdown appears
   showing currently live feature builds, each labeled `PR #N: <title>` with its
   build version and freshness.
2. Pick a PR from the dropdown. The app pins that PR's `pr<N>` channel, downloads and
   installs the build (requires a restart), and tracks the newest build of that PR as
   subsequent builds are cut.
3. The user's Stable or Nightly choice is preserved as **home** in `update-settings.json`
   (`channel: "latest" | "nightly"`). Picking a feature build never overwrites this.
4. **Return home** by clicking "Return to Stable" (or "Return to Nightly") in the
   settings banner, or set the channel back to Stable/Nightly manually. On the next
   update check the app resolves the home channel and reinstalls accordingly.
5. **Automatic fall-home:** if the pinned PR's build is retired (PR closed, merged, or
   7-day expiry), the app detects the retirement on its next update poll, clears the
   pin, and falls back to the preserved home channel automatically. No force-quit; the
   user is moved home on the next scheduled check.
