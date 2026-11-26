# Providers

Provider protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../packages/provider-core/src/server/ProviderAdapter.ts). Orchestration and
clients read declared capabilities, never provider names.

## Identity and integration shape

- **App IDs are primary; provider IDs are refs.** Never match native provider IDs globally without
  provider/session/thread scope, and never let child provider turn completions close a parent run.
- **Route by provider instance, not driver kind.** Session state, catalogs, and credentials belong
  to a provider instance so two accounts on the same driver cannot share mutable state. Strip
  ambient credentials the instance did not configure.
- **Strict ACP compliance for non-first-party agents.** Generic
  [ACP Registry](../user/providers-acp.md) and local ACP commands follow the ACP specification
  strictly—never deviate from the spec or add agent-id checks, vendor extensions, or
  driver-specific workarounds in the shared ACP adapter for non-first-party agents. If an upstream
  ACP agent deviates from or lacks part of the spec, let orchestration degrade through capabilities
  rather than special-casing it here. Dedicated ACP flavors (over `packages/provider-acp`) are
  reserved for first-party drivers that need behavior outside the ACP spec; native
  `ProviderAdapterV2` adapters are only for non-ACP protocols.
- **Package boundaries.** Providers live in `packages/provider-<name>` (see
  [Pi](../../packages/provider-pi) as reference). Server code imports only
  `@t3tools/provider-core/server/*`, contracts, and shared, reaching host capabilities through
  `ProviderHost` rather than `apps/server`. Client definitions (`./client`) must stay browser- and
  React Native-safe.

## Choose the integration shape

The generic ACP integration excludes per-agent branches, private vendor RPC or HTTP calls, and
readers for a vendor CLI's credentials or history. A dedicated driver requires a maintainer's
explicit decision to own that integration. Existing exceptions establish no precedent.

Decline workarounds for agents that violate the ACP spec and ask the author to file an issue with
the agent's maintainer, including a minimal protocol transcript and the relevant spec section.
Missing portable capabilities belong upstream in ACP. Vendor-neutral primitives, including shared
ACP text generation and user-hosted HTTP quota sources, are welcome.

A misleading permission guarantee in T3 is a T3 bug. Correct the shared behavior so the capability
and permission claims match what the protocol can enforce.

## Honest capabilities and permissions

- **Declare only what the provider actually supports.** Turn off fork, rollback, steering, or
  subagent capabilities the provider lacks so orchestration degrades cleanly (for example, portable
  context handoff for forks). A capability left enabled that fails at runtime is a bug.
- **Never emulate missing permission modes.** Expose only modes the provider enforces natively; do
  not fake a mode by auto-answering approvals in T3. Unoffered stored modes fall back to Supervised.
  Pass native approval and question option IDs through unchanged, and ensure every request can be
  declined.
- **Hide plan mode unless it produces proposed-plan cards.**
- **Startup phases come from real signals.** An adapter reports the step a starting turn is on as
  `startupPhase` on its provider session, and only when the protocol says so: a notification or an
  awaited request with one meaning, never a timer. Clear it the moment the provider can be doing
  something else. Clients show it until the run's first output. A session that serves several
  threads names the one it describes with `startupPhaseThreadId`.
  Nothing an adapter emits during `openSession` is visible, because the session is not attached yet.
  Turn start republishes `runtime.providerSession`, so a phase that spans it must be on that record.
- **Reject conversation rollback before touching files** when the provider cannot roll back its
  conversation (see [checkpoints](./01_architecture.md#turn-completion-and-checkpoints)).

## Process, setup, and security boundaries

- **Health checks must stay passive.** Background status and model probes must never open a session
  that starts MCP servers, runs hooks, or launches a login flow. Reserve heavier probes for explicit
  refresh or setup.
- **Updates run only through a provably owning installer.** Prove ownership from the resolved
  executable path (or use a self-updater that checks its own install); leave ambiguous, pinned, or
  read-only installs (such as Nix) manual-only.
- **Attachments stay outside the project workspace.** Never copy uploads into the project tree to
  bypass a provider's sandbox or approval rules.
- **T3 MCP tools.** Inject the thread's authenticated MCP server so agents can reach T3 tools, and
  keep turns working if that server is unreachable.

### Antigravity sandbox (fork)

Antigravity's own tools read the disk without asking T3, and the shared ACP policy approves every
read, so no T3-side check can keep a thread's agent out of T3's state. On Linux every `agy` process
therefore runs in a bubblewrap mount namespace that starts empty. It gets the operating system
read-only, the working directory and the thread's extra workspace folders, its own profile and
temporary folder, the thread's attachment folder read-only, and a HOME of its own inside the
profile. The real home directory, `/run`, `/tmp` and T3's state are simply not mounted, so nothing
has to be listed to stay hidden. A workspace folder is refused, and the launch with it, when it is
inside T3's state or holds the home directory; a thread's own checkout under T3's worktrees is the
one exception, and a workspace that holds T3's state (a dev server's) has that state emptied. It is
also refused when it is, holds or lies inside a folder the namespace mounts for itself (`/tmp`,
`/proc`, `/dev`, the system folders): mounted over one, it would put the host's back. T3's own
helper processes therefore work in a folder under `/var/tmp`.
The server answers `fs/read_text_file` from outside the namespace, so it applies the same view.

A thread's sessions get a profile of their own, beside the instance's rather than inside it,
because the agent names its conversation files itself and helper processes see the whole instance
profile. T3 reads a session's native files in its thread's profile. The agent can write its
profile, so T3 writes its own files there (`settings.json`, the sign-in) through the opened folder
without following links. Each launch copies the instance's sign-in files into the thread's
profile: we do not know how `agy` renews a token, and a copy lets it rewrite its own file in any
way without touching the one other threads start from.

The process inherits only a short list of variables from the server (PATH, locale, proxies), plus
the ones set on the provider instance. `bwrap` and the Node that checks the browser command run
outside the namespace and get none of them: the agent's variables are read inside, from a file in
its temporary folder rather than from `bwrap`'s arguments, which any user of the machine can list.
It gets no T3 MCP server, endpoint or credential: those tools read other threads and delegate work
to agents that run outside the namespace.

No `agy` process starts unless the namespace can be built, the installer's first run of a
download included. On Linux the Sandbox setting cannot turn this off; on other platforms, where no
sandbox exists, turning it off is how the user accepts running without one. The namespace does not
limit the network or files the agent writes in the workspace for a later process to run, and git
commands fail in a worktree checkout, whose repository lives outside it. Checkpoints are the one
thing T3 runs there by itself after a turn, so they run with the repository's hooks off. See
[the sandbox](../../apps/server/src/provider/antigravitySandbox.ts).

## Model manifest

The bundled [`model-manifest.json`](../../apps/server/src/provider/model-manifest.json) enables
offline startup while remote fetches from `main` update metadata between releases. A bundled
manifest outranks the cached remote copy by `updatedAt`, so **bump `updatedAt` on every edit**.
Declare broken-version minimums in the manifest policy rather than as driver constants. Test catalog
and adapter semantics with synthetic model names so adding a model never requires duplicating config
in tests.

## Cross-provider traps and testing

Prove adapter behavior with replay fixtures recorded from the real provider and replayed through the
real orchestrator, adapter, and projections. Hand-written protocol frames guess at wire behavior; use
unit tests for pure logic and failure paths a real provider cannot trigger on demand.

Traps that have broken multiple adapters:

- **Lazy config advertisement.** Providers often advertise options only after a session opens or a
  model runs. Wait for advertisement before applying settings, and skip unoffered stored options
  rather than failing.
- **`"Default"` is a sentinel, not a model ID.** Never send it to a provider; clear or reset the
  session's model selection instead.
- **Early Stop.** Cancelling before the provider registers the prompt can be ignored or strand a
  session. Gate cancellation on the provider's turn-started signal.
- **Work outliving a turn.** Background tasks, subagents, and provider-initiated continuations can
  report after T3's turn settles. Route subagent updates by subagent (not active run), request
  continuations when needed, and report pending background work so idle cleanup does not kill the
  session.
- **Terminal settlement.** Every terminal path (completion, Stop, provider error, process exit) must
  settle open tool calls, subagents, and pending requests.
- **Usage limits.** Classify quota/rate-limit errors as `usage_limit` (with reset time when
  available) rather than generic failures.
- **Symlinked workspaces.** Test symlinked paths (such as macOS `/tmp`); providers that compare
  canonical paths break if cwd handling disagrees.
