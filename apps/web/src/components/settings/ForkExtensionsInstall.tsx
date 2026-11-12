import type { EnvironmentId, ForkExtensionAgent, ForkExtensionProblem } from "@t3tools/contracts";
import { useDebouncer } from "@tanstack/react-pacer";
import { CheckIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { forkExtensionsInspectSource, forkExtensionsInstall } from "../../state/forkExtensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CLAUDE_AI_CONNECTORS_URL,
  FORK_AGENT_LABELS,
  type MachineState,
} from "./ForkExtensions.logic";
import { commandFailureProblem, ForkProblemText } from "./ForkExtensionsDetail";
import {
  DEFAULT_INSTALL_SELECTION,
  draftFromItem,
  draftFromPasted,
  findForkItem,
  FORK_INSTALL_TYPE_LABELS,
  FORK_INSTALL_TYPES,
  forkInstallInspectMachine,
  forkInstallPlan,
  forkInstallStatus,
  forkInstallTargetKey,
  forkInstallTargets,
  isInstallTargetChecked,
  isMcpInstallType,
  retypeDraft,
  type ForkInstallDraft,
  type ForkInstallSelection,
  type ForkInstallStatus,
  type ForkInstallTarget,
  type ForkMcpScope,
} from "./ForkExtensionsInstall.logic";

/** Typing pauses this long before the paste is read; a paste or "Install" reads it at once. */
const INSPECT_DEBOUNCE_MS = 300;

const SCOPE_LABELS: Readonly<Record<ForkMcpScope, string>> = {
  user: "User (all projects)",
  project: "Project",
  local: "Local",
};
const SCOPES: ReadonlyArray<ForkMcpScope> = ["user", "project", "local"];

/** "Install here" from the matrix or the detail: that item, with only that place checked. */
export interface ForkInstallHereTarget {
  readonly itemId: string;
  readonly environmentId: EnvironmentId;
  readonly agent: ForkExtensionAgent;
}

type FormState =
  | { readonly phase: "empty" }
  | { readonly phase: "inspecting" }
  | { readonly phase: "error"; readonly problem: ForkExtensionProblem }
  | {
      readonly phase: "ready";
      /** "item": opened by "Install here" for an item another machine has. */
      readonly origin: "pasted" | "item";
      readonly title: string | null;
      /** null: the paste was not recognised and the type is picked by hand. */
      readonly draft: ForkInstallDraft | null;
    };

const EMPTY_FORM: FormState = { phase: "empty" };

const NO_MACHINE: ForkExtensionProblem = {
  reason: "machineOffline",
  summary: "No machine can read this yet.",
  nextStep: "Connect a machine that runs this fork, then try again.",
  rawOutput: null,
};

function initialForm(
  machines: ReadonlyArray<MachineState>,
  installHere: ForkInstallHereTarget | null,
): FormState {
  const item =
    installHere === null
      ? null
      : findForkItem(machines, installHere.itemId, installHere.environmentId);
  if (item === null) return EMPTY_FORM;
  return { phase: "ready", origin: "item", title: item.name, draft: draftFromItem(item) };
}

const placeLabel = (target: ForkInstallTarget) =>
  `${target.machineLabel} · ${FORK_AGENT_LABELS[target.agent]}`;

/**
 * The paste-and-install bar and its form (spec §6.2). Remount it (a new `key`) to open it for an
 * item with `installHere`.
 */
export function ForkExtensionsInstall({
  machines,
  installHere,
}: {
  readonly machines: ReadonlyArray<MachineState>;
  readonly installHere: ForkInstallHereTarget | null;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Shown in the form, so no toast as well.
  const inspectSource = useAtomCommand(forkExtensionsInspectSource, { reportFailure: false });
  const install = useAtomCommand(forkExtensionsInstall, { reportFailure: false });
  const [text, setText] = useState("");
  const [form, setForm] = useState<FormState>(() => initialForm(machines, installHere));
  const [selection, setSelection] = useState<ForkInstallSelection>(() =>
    installHere === null
      ? DEFAULT_INSTALL_SELECTION
      : {
          only: forkInstallTargetKey(installHere.environmentId, installHere.agent),
          overrides: new Map(),
        },
  );
  const [projectByMachine, setProjectByMachine] = useState<ReadonlyMap<EnvironmentId, string>>(
    new Map(),
  );
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ForkInstallStatus>>(new Map());
  /** Only the latest paste's answer is shown. */
  const inspectRun = useRef(0);
  /** Only the latest install's answers are shown: closing or changing the form abandons it. */
  const installRun = useRef(0);
  const fieldId = useId();

  /** The running install keeps going on its machines; its answers are no longer shown. */
  const abandonInstall = () => {
    installRun.current += 1;
    setStatuses(new Map());
  };

  const resetChoices = () => {
    setSelection(DEFAULT_INSTALL_SELECTION);
    setProjectByMachine(new Map());
    abandonInstall();
  };

  const inspect = async (value: string) => {
    const run = ++inspectRun.current;
    const environmentId = forkInstallInspectMachine(machines, primaryEnvironmentId);
    if (environmentId === null) {
      setForm({ phase: "error", problem: NO_MACHINE });
      return;
    }
    setForm({ phase: "inspecting" });
    const result = await inspectSource({ environmentId, input: { text: value.trim() } });
    if (run !== inspectRun.current) return;
    if (result._tag === "Failure") {
      const problem = commandFailureProblem(result);
      setForm(problem === null ? EMPTY_FORM : { phase: "error", problem });
      return;
    }
    resetChoices();
    setForm({
      phase: "ready",
      origin: "pasted",
      title: null,
      draft: draftFromPasted(result.value),
    });
  };
  // Typing changes the text on every key; reading it each time would ask the machine (and, for
  // a GitHub repo, GitHub) once per keystroke. The debouncer cancels itself on unmount.
  const debouncedInspect = useDebouncer((value: string) => void inspect(value), {
    wait: INSPECT_DEBOUNCE_MS,
  });

  const close = () => {
    debouncedInspect.cancel();
    inspectRun.current += 1;
    setText("");
    setForm(EMPTY_FORM);
    resetChoices();
  };

  const changeText = (value: string, pasted: boolean) => {
    setText(value);
    if (value.trim() === "") {
      close();
      return;
    }
    if (pasted) {
      debouncedInspect.cancel();
      void inspect(value);
    } else {
      debouncedInspect.maybeExecute(value);
    }
  };

  const draft = form.phase === "ready" ? form.draft : null;
  const rows = draft === null ? [] : forkInstallTargets(machines, draft);
  const plan = draft === null ? null : forkInstallPlan(draft, rows, selection, projectByMachine);
  const running = [...statuses.values()].some((status) => status.phase === "running");
  // Results describe what was sent; an edit makes the next install a new one.
  const updateDraft = (patch: Partial<ForkInstallDraft>) => {
    abandonInstall();
    setForm((current) =>
      current.phase === "ready" && current.draft !== null
        ? { ...current, draft: { ...current.draft, ...patch } }
        : current,
    );
  };
  const changeType = (value: unknown) => {
    const type = FORK_INSTALL_TYPES.find((candidate) => candidate === value);
    if (type === undefined) return;
    abandonInstall();
    setForm((current) =>
      current.phase === "ready"
        ? { ...current, draft: retypeDraft(current.draft, type, text) }
        : current,
    );
  };

  const runInstall = async () => {
    if (plan === null || plan.blocker !== null || running) return;
    const { calls } = plan;
    debouncedInspect.cancel();
    const run = ++installRun.current;
    setStatuses((current) => {
      const next = new Map(current);
      for (const call of calls) {
        for (const agent of call.agents) {
          next.set(forkInstallTargetKey(call.environmentId, agent), { phase: "running" });
        }
      }
      return next;
    });
    // One call per machine, all at once: each machine's places show its own answer as soon as
    // it comes, whatever the others do (spec §6.2). The command refreshes that machine's
    // snapshot when it settles.
    await Promise.all(
      calls.map(async (call) => {
        const result = await install({ environmentId: call.environmentId, input: call.request });
        if (run !== installRun.current) return;
        const failure = result._tag === "Failure" ? commandFailureProblem(result) : null;
        setStatuses((current) => {
          const next = new Map(current);
          for (const agent of call.agents) {
            const key = forkInstallTargetKey(call.environmentId, agent);
            if (result._tag === "Success") next.set(key, forkInstallStatus(result.value, agent));
            else if (failure !== null) next.set(key, { phase: "failed", problem: failure });
            else next.delete(key);
          }
          return next;
        });
      }),
    );
  };

  const toggleTarget = (target: ForkInstallTarget, checked: boolean) =>
    setSelection((current) => ({
      ...current,
      overrides: new Map(current.overrides).set(target.key, checked),
    }));

  const autoFocus = form.phase === "ready" && form.origin === "item";

  return (
    <div className="space-y-3 px-3 pt-3 sm:px-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (running || text.trim() === "") return;
          debouncedInspect.cancel();
          void inspect(text);
        }}
      >
        <Input
          aria-label="Paste something to install"
          placeholder="Paste a URL, a command, a GitHub repo or a plugin name…"
          font={text === "" ? "default" : "mono"}
          value={text}
          disabled={running}
          onChange={(event) =>
            changeText(
              event.currentTarget.value,
              (event.nativeEvent as InputEvent).inputType === "insertFromPaste",
            )
          }
        />
        <Button type="submit" size="sm" disabled={running || text.trim() === ""}>
          Install
        </Button>
      </form>

      {form.phase === "inspecting" ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="xs" />
          Detecting…
        </p>
      ) : null}
      {form.phase === "error" ? (
        <div className="rounded-md border border-destructive/30 p-2 text-xs">
          <ForkProblemText problem={form.problem} />
        </div>
      ) : null}

      {form.phase === "ready" ? (
        <div className="space-y-3 rounded-md border border-border/60 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5">
            {form.origin === "item" ? (
              <span>
                Install <b className="font-semibold">{form.title}</b>
                {draft === null ? null : ` · ${FORK_INSTALL_TYPE_LABELS[draft.type]}`}
              </span>
            ) : draft === null ? (
              <span>Couldn't tell what this is.</span>
            ) : (
              <span>
                Detected: <b className="font-semibold">{FORK_INSTALL_TYPE_LABELS[draft.type]}</b>
              </span>
            )}
            <span className="flex-1" />
            {form.origin === "pasted" ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                {draft === null ? "Pick its type:" : "Not this?"}
                <Select value={draft?.type ?? null} disabled={running} onValueChange={changeType}>
                  <SelectTrigger size="xs" aria-label="Type" className="min-w-0">
                    <SelectValue>{draft === null ? "Pick a type" : "Change type"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {FORK_INSTALL_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {FORK_INSTALL_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </span>
            ) : null}
          </div>

          {draft === null ? null : draft.type === "claudeAiConnector" ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                claude.ai connectors belong to your Claude account, not to a machine. Connect it on
                claude.ai and it shows up on all your machines.
              </p>
              <Button
                size="xs"
                variant="outline"
                autoFocus={autoFocus}
                onClick={() => void ensureLocalApi().shell.openExternal(CLAUDE_AI_CONNECTORS_URL)}
              >
                Open claude.ai connectors
                <ExternalLinkIcon aria-hidden />
              </Button>
            </div>
          ) : (
            <>
              <DraftFields
                draft={draft}
                fieldId={fieldId}
                autoFocus={autoFocus}
                disabled={running}
                onChange={updateDraft}
              />
              <div className="space-y-1.5">
                <p className="text-muted-foreground">Where should it go?</p>
                <table className="w-auto border-collapse">
                  <thead>
                    <tr>
                      <th scope="col" className="pe-6 text-start font-normal">
                        <span className="sr-only">Machine</span>
                      </th>
                      {(["claude", "codex"] as const).map((agent) => (
                        <th
                          key={agent}
                          scope="col"
                          className="px-3 pb-1 text-center font-medium text-muted-foreground"
                        >
                          {FORK_AGENT_LABELS[agent]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.environmentId} className="border-t border-border/60">
                        <th scope="row" className="py-1.5 pe-6 text-start font-normal">
                          {row.machineLabel}
                        </th>
                        {row.targets.map((target) => (
                          <td key={target.key} className="px-3 py-1.5 text-center">
                            <TargetCell
                              target={target}
                              checked={isInstallTargetChecked(target, selection)}
                              status={statuses.get(target.key) ?? null}
                              disabled={running}
                              onCheckedChange={(checked) => toggleTarget(target, checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {isMcpInstallType(draft.type) && draft.scope !== "user" ? (
                <ProjectPickers
                  rows={rows.filter((row) =>
                    row.targets.some((target) => isInstallTargetChecked(target, selection)),
                  )}
                  projectByMachine={projectByMachine}
                  disabled={running}
                  onPick={(environmentId, path) =>
                    setProjectByMachine((current) => new Map(current).set(environmentId, path))
                  }
                />
              ) : null}
              <StatusProblems rows={rows} statuses={statuses} />
            </>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {plan?.blocker != null && draft?.type !== "claudeAiConnector" ? (
              <span className="text-muted-foreground">{plan.blocker}</span>
            ) : null}
            {/* Closing mid-install leaves the machines to finish; the matrix refreshes. */}
            <Button size="xs" variant="outline" onClick={close}>
              {statuses.size > 0 ? "Close" : "Cancel"}
            </Button>
            {plan !== null && draft?.type !== "claudeAiConnector" ? (
              <Button
                size="xs"
                disabled={plan.blocker !== null || running}
                onClick={() => void runInstall()}
              >
                {running ? <Spinner size="xs" /> : null}
                Install in {plan.count} {plan.count === 1 ? "place" : "places"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      {id === undefined ? (
        <span className="text-muted-foreground">{label}</span>
      ) : (
        <label htmlFor={id} className="text-muted-foreground">
          {label}
        </label>
      )}
      <div className="min-w-0">{children}</div>
    </>
  );
}

function DraftFields({
  draft,
  fieldId,
  autoFocus,
  disabled,
  onChange,
}: {
  readonly draft: ForkInstallDraft;
  readonly fieldId: string;
  readonly autoFocus: boolean;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<ForkInstallDraft>) => void;
}) {
  const id = (name: string) => `${fieldId}-${name}`;
  const text = (
    name: string,
    value: string,
    patch: (value: string) => Partial<ForkInstallDraft>,
    options: { readonly mono?: boolean; readonly focus?: boolean; readonly placeholder?: string },
  ) => (
    <Input
      id={id(name)}
      size="sm"
      font={options.mono ? "mono" : "default"}
      value={value}
      disabled={disabled}
      placeholder={options.placeholder}
      autoFocus={autoFocus && options.focus === true}
      onChange={(event) => onChange(patch(event.currentTarget.value))}
    />
  );
  const name = (
    <Field id={id("name")} label="Name">
      {text("name", draft.name, (value) => ({ name: value }), { focus: true })}
    </Field>
  );
  return (
    <div className="grid grid-cols-[7rem_minmax(0,24rem)] items-center gap-x-3 gap-y-2">
      {draft.type === "mcpHttp" || draft.type === "mcpSse" ? (
        <>
          {name}
          <Field id={id("url")} label="URL">
            {text("url", draft.url, (value) => ({ url: value }), { mono: true })}
          </Field>
        </>
      ) : null}
      {draft.type === "mcpCommand" ? (
        <>
          {name}
          <Field id={id("command")} label="Command">
            {text("command", draft.commandLine, (value) => ({ commandLine: value }), {
              mono: true,
            })}
          </Field>
        </>
      ) : null}
      {isMcpInstallType(draft.type) ? (
        <Field label="Scope">
          <Select
            value={draft.scope}
            disabled={disabled}
            onValueChange={(value) => {
              const scope = SCOPES.find((candidate) => candidate === value);
              if (scope !== undefined) onChange({ scope });
            }}
          >
            <SelectTrigger size="sm" aria-label="Scope">
              <SelectValue>{SCOPE_LABELS[draft.scope]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {SCOPE_LABELS[scope]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      ) : null}
      {draft.type === "plugin" ? (
        <Field id={id("plugin")} label="Plugin">
          {text("plugin", draft.pluginRef, (value) => ({ pluginRef: value }), {
            mono: true,
            focus: true,
            placeholder: "name@marketplace",
          })}
        </Field>
      ) : null}
      {draft.type === "marketplace" ? (
        <>
          <Field id={id("marketplace")} label="Marketplace">
            {text(
              "marketplace",
              draft.marketplaceSource,
              (value) => ({ marketplaceSource: value }),
              { mono: true, focus: true, placeholder: "owner/repo" },
            )}
          </Field>
          {draft.marketplacePlugins.length > 0 ? (
            <Field label="Plugin">
              <Select
                value={draft.pluginRef}
                disabled={disabled}
                onValueChange={(value) => {
                  if (typeof value === "string") onChange({ pluginRef: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Plugin">
                  <SelectValue>{draft.pluginRef}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {draft.marketplacePlugins.map((plugin) => (
                    <SelectItem key={plugin} value={plugin}>
                      {plugin}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : (
            <Field id={id("plugin")} label="Plugin">
              {text("plugin", draft.pluginRef, (value) => ({ pluginRef: value }), {
                mono: true,
              })}
            </Field>
          )}
        </>
      ) : null}
      {draft.type === "skill" ? (
        <>
          {name}
          <Field id={id("source")} label="Source">
            {text("source", draft.skillSource, (value) => ({ skillSource: value }), {
              mono: true,
              placeholder: "owner/repo/path or a folder",
            })}
          </Field>
        </>
      ) : null}
    </div>
  );
}

function StatusIcon({
  target,
  status,
}: {
  readonly target: ForkInstallTarget;
  readonly status: ForkInstallStatus;
}) {
  const place = placeLabel(target);
  switch (status.phase) {
    case "running":
      return (
        <span role="img" aria-label={`Installing on ${place}`} className="inline-flex">
          <Spinner size="xs" tone="muted" />
        </span>
      );
    case "done":
      return (
        <span
          role="img"
          aria-label={`Installed on ${place}`}
          className={cn("inline-flex", status.problem === null ? "text-success" : "text-warning")}
        >
          <CheckIcon className="size-3.5" aria-hidden />
        </span>
      );
    case "failed":
      return (
        <span role="img" aria-label={`Failed on ${place}`} className="inline-flex text-destructive">
          <XIcon className="size-3.5" aria-hidden />
        </span>
      );
  }
}

function TargetCell({
  target,
  checked,
  status,
  disabled,
  onCheckedChange,
}: {
  readonly target: ForkInstallTarget;
  readonly checked: boolean;
  readonly status: ForkInstallStatus | null;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const icon = status === null ? null : <StatusIcon target={target} status={status} />;
  if (target.blocked === null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Checkbox
          aria-label={placeLabel(target)}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        {icon}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          {target.notApplicable ? (
            // The mockup's "—" for n/a, drawn rather than written.
            <span
              role="img"
              aria-label={`${placeLabel(target)}: not available`}
              className="inline-flex h-4 w-4 items-center justify-center"
            >
              <span aria-hidden className="inline-block h-px w-2.5 bg-muted-foreground" />
            </span>
          ) : (
            <Checkbox aria-label={placeLabel(target)} checked={false} disabled />
          )}
        </TooltipTrigger>
        <TooltipPopup>{target.blocked}</TooltipPopup>
      </Tooltip>
      {icon}
    </span>
  );
}

function ProjectPickers({
  rows,
  projectByMachine,
  disabled,
  onPick,
}: {
  readonly rows: ReturnType<typeof forkInstallTargets>;
  readonly projectByMachine: ReadonlyMap<EnvironmentId, string>;
  readonly disabled: boolean;
  readonly onPick: (environmentId: EnvironmentId, path: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,24rem)] items-center gap-x-3 gap-y-2">
      {rows.map((row) => {
        const picked = row.projects.find(
          (project) => project.path === projectByMachine.get(row.environmentId),
        );
        return (
          <Field key={row.environmentId} label={`Project on ${row.machineLabel}`}>
            <Select
              value={picked?.path ?? null}
              disabled={disabled}
              onValueChange={(value) => {
                if (typeof value === "string") onPick(row.environmentId, value);
              }}
            >
              <SelectTrigger size="sm" aria-label={`Project on ${row.machineLabel}`}>
                <SelectValue>{picked?.title ?? "Pick a project"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {row.projects.map((project) => (
                  <SelectItem key={project.path} value={project.path}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        );
      })}
    </div>
  );
}

/** Each failed or warned place's cause and next step (spec §7.4). */
function StatusProblems({
  rows,
  statuses,
}: {
  readonly rows: ReturnType<typeof forkInstallTargets>;
  readonly statuses: ReadonlyMap<string, ForkInstallStatus>;
}) {
  const entries = rows.flatMap((row) =>
    row.targets.flatMap((target) => {
      const status = statuses.get(target.key);
      if (status === undefined || status.phase === "running" || status.problem === null) return [];
      return [{ target, problem: status.problem, failed: status.phase === "failed" }];
    }),
  );
  if (entries.length === 0) return null;
  return (
    <ul className="space-y-2">
      {entries.map(({ target, problem, failed }) => (
        <li key={target.key} className="flex min-w-0 flex-col gap-0.5">
          <span className={cn("font-medium", failed ? "text-destructive" : "text-warning")}>
            {failed ? "Couldn't install on" : "Installed with a warning on"} {placeLabel(target)}
          </span>
          <ForkProblemText problem={problem} />
        </li>
      ))}
    </ul>
  );
}
