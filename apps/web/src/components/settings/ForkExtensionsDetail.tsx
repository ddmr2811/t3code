import type {
  EnvironmentId,
  ForkExtensionAgent,
  ForkExtensionCell,
  ForkExtensionItem,
  ForkExtensionProblem,
  ForkInstallResult,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState, type ReactNode } from "react";

import { forkExtensionsSetEnabled, forkExtensionsUninstall } from "../../state/forkExtensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import {
  FORK_AGENT_LABELS,
  forkCellStateLabel,
  forkColumnLabel,
  forkProjectToggleGroups,
  forkSourceTag,
  forkUninstallTargets,
  isSnapshotCell,
  type ForkUninstallTarget,
  type MatrixCell,
  type MatrixColumn,
  type MatrixRow,
} from "./ForkExtensions.logic";

export type OnForkInstallHere = (
  itemId: string,
  environmentId: EnvironmentId,
  agent: ForkExtensionAgent,
) => void;

/** A command's outcome, shown on the page until dismissed; a newer one with its key replaces it. */
export interface ForkNotice {
  readonly key: string;
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly problem: ForkExtensionProblem | null;
}

/** An RPC that failed outright (not an `ok: false` result) as a problem; null when interrupted. */
export function commandFailureProblem(
  result: AtomCommandResult<unknown, unknown>,
): ForkExtensionProblem | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "problem" in error) {
    return (error as { readonly problem: ForkExtensionProblem }).problem;
  }
  return {
    reason: "commandFailed",
    summary: error instanceof Error ? error.message : "The machine did not answer.",
    nextStep: "Check that the machine is connected, then try again.",
    rawOutput: null,
  };
}

/** `ok` decides success; `ok` with a problem is a success with a warning. */
export function resultNotice(
  key: string,
  result: ForkInstallResult,
  titles: { readonly done: string; readonly failed: string },
): ForkNotice | null {
  if (!result.ok) return { key, tone: "error", title: titles.failed, problem: result.problem };
  if (result.problem !== null) {
    return { key, tone: "warning", title: titles.done, problem: result.problem };
  }
  return null;
}

/** Summary, next step and, on request, the CLI's raw output (spec §7.4). */
export function ForkProblemText({ problem }: { readonly problem: ForkExtensionProblem }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="wrap-anywhere">{problem.summary}</span>
      {problem.nextStep ? (
        <span className="wrap-anywhere text-muted-foreground">{problem.nextStep}</span>
      ) : null}
      {problem.rawOutput ? (
        <>
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((shown) => !shown)}
          >
            {showRaw ? "Hide details" : "Show details"}
          </button>
          {showRaw ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap text-foreground">
              {problem.rawOutput}
            </pre>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

export interface ForkDetailCellContext {
  readonly column: MatrixColumn;
  readonly cell: MatrixCell;
  /** This machine's copy of the item, if it has one. */
  readonly item: ForkExtensionItem | undefined;
}

export interface ForkExtensionsDetailProps {
  readonly row: MatrixRow;
  readonly columns: ReadonlyArray<MatrixColumn>;
  readonly nowMs: number;
  readonly onInstallHere: OnForkInstallHere;
  readonly onNotices: (notices: ReadonlyArray<ForkNotice>) => void;
  /** Slot for Task 15: actions on one cell, such as "Authorize". */
  readonly renderCellActions?: (context: ForkDetailCellContext) => ReactNode;
  /** Slot for Task 15: the "Per project" section. */
  readonly children?: ReactNode;
}

const SOURCE_LABELS = { stdio: "Command", http: "URL", sse: "URL" } as const;

export function ForkExtensionsDetail({
  row,
  columns,
  nowMs,
  onInstallHere,
  onNotices,
  renderCellActions,
  children,
}: ForkExtensionsDetailProps) {
  const { item } = row;
  const tag = forkSourceTag(item);
  const sources = [...row.itemsByMachine].map(([environmentId, copy]) => ({
    environmentId,
    machineLabel:
      columns.find((column) => column.environmentId === environmentId)?.machineLabel ??
      environmentId,
    source: copy.source,
    label:
      copy.transport === "stdio" || copy.transport === "http" || copy.transport === "sse"
        ? SOURCE_LABELS[copy.transport]
        : "Source",
  }));
  const sameSource = sources.every((entry) => entry.source === sources[0]?.source);

  return (
    <section
      aria-label={`${item.name} details`}
      className="space-y-3 border-t border-border/60 px-3 py-3 text-xs sm:px-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{item.name}</h3>
        {tag ? (
          <span className="shrink-0 rounded-full border border-border px-2 py-px text-2xs text-muted-foreground">
            {tag}
          </span>
        ) : null}
        <span className="flex-1" />
        <UninstallButton row={row} columns={columns} onNotices={onNotices} />
      </div>
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1.5">
        {sources.length === 0 ? null : sameSource ? (
          <DetailEntry term={sources[0]!.label}>
            <span className="font-mono wrap-anywhere">{sources[0]!.source || "(none)"}</span>
          </DetailEntry>
        ) : (
          sources.map((entry) => (
            <DetailEntry key={entry.environmentId} term={`${entry.label} on ${entry.machineLabel}`}>
              <span className="font-mono wrap-anywhere">{entry.source || "(none)"}</span>
            </DetailEntry>
          ))
        )}
        {columns.map((column, index) => {
          const cell = row.cells[index]!;
          const context: ForkDetailCellContext = {
            column,
            cell,
            item: row.itemsByMachine.get(column.environmentId),
          };
          return (
            <DetailEntry key={column.key} term={forkColumnLabel(column)}>
              <CellDetail
                context={context}
                itemId={item.id}
                nowMs={nowMs}
                onInstallHere={onInstallHere}
              />
              {renderCellActions?.(context)}
            </DetailEntry>
          );
        })}
      </dl>
      {/* The "Per project" section (ForkPerProjectSection) when the page passes it. */}
      {children}
    </section>
  );
}

function DetailEntry({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="font-medium text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 flex-col gap-1">{children}</dd>
    </>
  );
}

function usageLabel(usageCount: number, lastUsedAt: string | null, nowMs: number): string {
  const uses = `${usageCount} ${usageCount === 1 ? "use" : "uses"}`;
  return lastUsedAt === null
    ? uses
    : `${uses} · last used ${formatRelativeTimeLabel(lastUsedAt, nowMs)}`;
}

function CellDetail({
  context: { column, cell },
  itemId,
  nowMs,
  onInstallHere,
}: {
  readonly context: ForkDetailCellContext;
  readonly itemId: string;
  readonly nowMs: number;
  readonly onInstallHere: OnForkInstallHere;
}) {
  if (cell.state === "agentUnavailable" && column.problem !== null) {
    return <ForkProblemText problem={column.problem} />;
  }
  if (cell.state === "notInstalled") {
    const agent = column.agent;
    return (
      <span className="text-muted-foreground">
        Not installed
        {agent !== null && column.canOperate ? (
          <>
            {". "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => onInstallHere(itemId, column.environmentId, agent)}
            >
              Install here
            </button>
          </>
        ) : null}
      </span>
    );
  }
  if (!isSnapshotCell(cell)) {
    return <span className="text-muted-foreground">{forkCellStateLabel(cell)}</span>;
  }
  return (
    <>
      <span className={cell.state === "needsAttention" ? "text-warning" : undefined}>
        {forkCellStateLabel(cell)}
        <span className="text-muted-foreground">
          {" · "}
          {usageLabel(cell.usageCount, cell.lastUsedAt, nowMs)}
        </span>
      </span>
      {cell.problem !== null ? <ForkProblemText problem={cell.problem} /> : null}
      {cell.stashDiscarded ? (
        <span className="text-muted-foreground">
          A disabled copy was discarded because you added it again from the terminal.
        </span>
      ) : null}
    </>
  );
}

const targetKey = (target: ForkUninstallTarget) => `${target.environmentId}\n${target.agent}`;

function UninstallButton({
  row,
  columns,
  onNotices,
}: {
  readonly row: MatrixRow;
  readonly columns: ReadonlyArray<MatrixColumn>;
  readonly onNotices: (notices: ReadonlyArray<ForkNotice>) => void;
}) {
  const uninstall = useAtomCommand(forkExtensionsUninstall);
  const targets = forkUninstallTargets(row, columns);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  if (targets.length === 0) return null;
  const { item } = row;

  const confirm = async () => {
    const chosen = targets.filter((target) => selected.has(targetKey(target)));
    const byMachine = new Map<EnvironmentId, Array<ForkUninstallTarget>>();
    for (const target of chosen) {
      byMachine.set(target.environmentId, [...(byMachine.get(target.environmentId) ?? []), target]);
    }
    setOpen(false);
    setRunning(true);
    const outcomes = await Promise.all(
      [...byMachine].map(async ([environmentId, machineTargets]) => {
        const agents = machineTargets.map((target) => target.agent);
        const result = await uninstall({
          environmentId,
          input: {
            itemId: item.id,
            agents: agents as [ForkExtensionAgent, ...ForkExtensionAgent[]],
          },
        });
        return { machineTargets, result };
      }),
    );
    setRunning(false);
    const notices: Array<ForkNotice> = [];
    const done: Array<string> = [];
    for (const { machineTargets, result } of outcomes) {
      for (const target of machineTargets) {
        const place = `${target.machineLabel} · ${FORK_AGENT_LABELS[target.agent]}`;
        const key = `uninstall:${item.id}:${targetKey(target)}`;
        const failed = `Couldn't uninstall ${item.name} from ${place}`;
        if (result._tag === "Failure") {
          const problem = commandFailureProblem(result);
          if (problem !== null) notices.push({ key, tone: "error", title: failed, problem });
          continue;
        }
        const own = result.value.find((entry) => entry.agent === target.agent);
        if (own === undefined) continue;
        const notice = resultNotice(key, own, {
          done: `Uninstalled ${item.name} from ${place}`,
          failed,
        });
        if (notice === null) done.push(place);
        else notices.push(notice);
      }
    }
    if (done.length > 0) {
      notices.unshift({
        key: `uninstall:${item.id}`,
        tone: "success",
        title: `Uninstalled ${item.name} from ${done.join(", ")}`,
        problem: null,
      });
    }
    onNotices(notices);
  };

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={running}
        onClick={() => {
          setSelected(new Set(targets.map(targetKey)));
          setOpen(true);
        }}
      >
        {running ? "Uninstalling…" : "Uninstall…"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {item.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from the places you pick. Other copies stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 px-6 pb-2">
            {targets.map((target) => {
              const key = targetKey(target);
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(key)}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                  {target.machineLabel} · {FORK_AGENT_LABELS[target.agent]}
                </label>
              );
            })}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={selected.size === 0}
              onClick={() => void confirm()}
            >
              Uninstall
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const UNOPENED_PROJECT_REASON =
  "Claude Code has no settings for this project yet. Open it in Claude Code once.";

/** A switch's requested value, shown until the snapshot that answers it replaces `cell`. */
interface ProjectToggleRequest {
  readonly enabled: boolean;
  readonly cell: ForkExtensionCell;
}

/**
 * Spec §6.4: a Claude MCP can also be turned off in single projects. One switch per project the
 * machine lists for it; results arrive through the page's notices.
 */
export function ForkPerProjectSection({
  row,
  columns,
  onNotices,
  onNoticeCleared,
}: {
  readonly row: MatrixRow;
  readonly columns: ReadonlyArray<MatrixColumn>;
  readonly onNotices: (notices: ReadonlyArray<ForkNotice>) => void;
  readonly onNoticeCleared: (key: string) => void;
}) {
  const setEnabled = useAtomCommand(forkExtensionsSetEnabled);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [requested, setRequested] = useState<ReadonlyMap<string, ProjectToggleRequest>>(new Map());
  const groups = forkProjectToggleGroups(row, columns);
  if (groups.length === 0) return null;
  const { item } = row;

  const toggle = async (
    column: MatrixColumn,
    cell: ForkExtensionCell,
    project: ForkExtensionCell["projects"][number],
    enabled: boolean,
  ) => {
    const key = `${column.key}\n${project.path}`;
    if (pending.has(key)) return;
    setPending((current) => new Set(current).add(key));
    setRequested((current) => new Map(current).set(key, { enabled, cell }));
    const result = await setEnabled({
      environmentId: column.environmentId,
      input: { itemId: item.id, agent: cell.agent, enabled, projectPath: project.path },
    });
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    const noticeKey = `project:${item.id}\n${key}`;
    const verb = enabled ? "on" : "off";
    const where = `${item.name} in ${project.title || project.path} on ${forkColumnLabel(column)}`;
    const failed = `Couldn't turn ${verb} ${where}`;
    if (result._tag === "Failure" || !result.value.ok) {
      setRequested((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
    if (result._tag === "Failure") {
      const problem = commandFailureProblem(result);
      if (problem !== null) onNotices([{ key: noticeKey, tone: "error", title: failed, problem }]);
      return;
    }
    const notice = resultNotice(noticeKey, result.value, {
      done: `Turned ${verb} ${where}`,
      failed,
    });
    if (notice === null) onNoticeCleared(noticeKey);
    else onNotices([notice]);
  };

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <h4 className="font-medium text-foreground">Per project</h4>
      {groups.map(({ column, cell, blockedReason }) => {
        const place = forkColumnLabel(column);
        return (
          <div key={column.key} className="space-y-1">
            <p className="text-muted-foreground">
              {place}
              {blockedReason === null ? null : `. ${blockedReason}`}
            </p>
            <ul className="space-y-1">
              {cell.projects.map((project) => {
                const key = `${column.key}\n${project.path}`;
                const request = requested.get(key);
                // Until a new snapshot answers, the switch shows what was asked for.
                const checked =
                  request !== undefined && request.cell === cell
                    ? request.enabled
                    : !project.disabled;
                const name = project.title || project.path;
                // Claude has no `~/.claude.json` entry for it yet, and T3 never invents one.
                const unopened = project.unopened === true;
                return (
                  <li key={project.path} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Switch
                        size="sm"
                        aria-label={`${name} on ${place}`}
                        checked={checked}
                        disabled={blockedReason !== null || unopened || pending.has(key)}
                        onCheckedChange={(next) => void toggle(column, cell, project, next)}
                      />
                      <span className="min-w-0 truncate text-foreground">{name}</span>
                      {project.title && project.title !== project.path ? (
                        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                          {project.path}
                        </span>
                      ) : null}
                    </div>
                    {unopened ? (
                      <p className="pl-9 text-muted-foreground">{UNOPENED_PROJECT_REASON}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
