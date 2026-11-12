import type { ForkExtensionKind } from "@t3tools/contracts";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { forkExtensionsSetEnabled } from "../../state/forkExtensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildMatrix,
  FORK_AGENT_LABELS,
  FORK_KIND_LABELS,
  forkCellAction,
  forkCellStateLabel,
  forkColumnLabel,
  forkSourceTag,
  oldestHealthCheck,
  type MatrixCell,
  type MatrixColumn,
  type MatrixRow,
} from "./ForkExtensions.logic";
import { ForkAuthorizeButton, useForkAuthorize } from "./ForkExtensionsAuthorize";
import {
  commandFailureProblem,
  ForkExtensionsDetail,
  ForkPerProjectSection,
  ForkProblemText,
  resultNotice,
  type ForkNotice,
  type OnForkInstallHere,
} from "./ForkExtensionsDetail";
import { ForkExtensionsInstall, type ForkInstallHereTarget } from "./ForkExtensionsInstall";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useForkExtensions } from "./useForkExtensions";

const KINDS: ReadonlyArray<ForkExtensionKind> = ["mcp", "plugin", "skill"];

const EMPTY_KIND_LABELS: Readonly<Record<ForkExtensionKind, string>> = {
  mcp: "No MCP servers on these machines yet.",
  plugin: "No plugins on these machines yet.",
  skill: "No skills on these machines yet.",
};

export function ForkExtensionsSettings() {
  const { machines, checkHealth } = useForkExtensions();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const setEnabled = useAtomCommand(forkExtensionsSetEnabled);
  const [kind, setKind] = useState<ForkExtensionKind>("mcp");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<ReadonlyArray<ForkNotice>>([]);
  // Each "Install here" remounts the form (a new key) with that item and only that place checked.
  const [installHere, setInstallHere] = useState<{
    readonly key: number;
    readonly target: ForkInstallHereTarget | null;
  }>({ key: 0, target: null });
  const onInstallHere: OnForkInstallHere = (itemId, environmentId, agent) =>
    setInstallHere((current) => ({
      key: current.key + 1,
      target: { itemId, environmentId, agent },
    }));

  const matrices = new Map(KINDS.map((entry) => [entry, buildMatrix(machines, entry)] as const));
  const { columns, rows } = matrices.get(kind)!;
  const selectedRow = rows.find((row) => row.item.id === selectedId);
  const answered = machines.filter((machine) => machine.snapshot !== null);
  const anyChecking = machines.some((machine) => machine.isCheckingHealth);
  const oldestCheck = oldestHealthCheck(answered);
  // Supported machines without a snapshot yet have no column (spec §7.2): say why here.
  const statusLines = machines.flatMap((machine) => {
    const lines: Array<{ key: string; tone: "muted" | "warning"; text: string }> = [];
    if (machine.support === "supported" && machine.snapshot === null) {
      if (machine.error !== null) {
        lines.push({
          key: `${machine.environmentId}:error`,
          tone: "warning",
          text: `${machine.label}: ${machine.error}`,
        });
      } else {
        lines.push({
          key: `${machine.environmentId}:loading`,
          tone: "muted",
          text: `Loading extensions on ${machine.label}…`,
        });
      }
    }
    if (machine.healthError !== null) {
      lines.push({
        key: `${machine.environmentId}:health`,
        tone: "warning",
        text: `Couldn't check status on ${machine.label}: ${machine.healthError}`,
      });
    }
    return lines;
  });

  const addNotices = (next: ReadonlyArray<ForkNotice>) =>
    setNotices((current) => [
      ...next,
      ...current.filter((notice) => !next.some((entry) => entry.key === notice.key)),
    ]);
  const dropNotice = (key: string) =>
    setNotices((current) => current.filter((notice) => notice.key !== key));
  // A finished login changes what that machine's health check reports (spec §6.7).
  const authorize = useForkAuthorize({
    onNotices: addNotices,
    onAuthorized: (environmentId) => checkHealth(environmentId),
  });

  const clickCell = async (row: MatrixRow, column: MatrixColumn, cell: MatrixCell) => {
    const action = forkCellAction(
      column,
      cell,
      row.itemsByMachine.get(column.environmentId) ?? row.item,
    );
    if (action.kind === "none") return;
    if (action.kind === "install") {
      onInstallHere(row.item.id, column.environmentId, action.agent);
      return;
    }
    const key = `${row.item.id}\n${column.key}`;
    if (pending.has(key)) return;
    setPending((current) => new Set(current).add(key));
    const result = await setEnabled({
      environmentId: column.environmentId,
      input: {
        itemId: row.item.id,
        agent: action.agent,
        enabled: action.enabled,
        projectPath: null,
      },
    });
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    const verb = action.enabled ? "turn on" : "turn off";
    const place = forkColumnLabel(column);
    const noticeKey = `toggle:${key}`;
    const failed = `Couldn't ${verb} ${row.item.name} on ${place}`;
    if (result._tag === "Failure") {
      const problem = commandFailureProblem(result);
      if (problem !== null) addNotices([{ key: noticeKey, tone: "error", title: failed, problem }]);
      return;
    }
    const notice = resultNotice(noticeKey, result.value, {
      done: `${action.enabled ? "Turned on" : "Turned off"} ${row.item.name} on ${place}`,
      failed,
    });
    if (notice === null) dropNotice(noticeKey);
    else addNotices([notice]);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("fork-extensions")}>
        <ForkExtensionsInstall
          key={installHere.key}
          machines={machines}
          installHere={installHere.target}
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3 sm:px-4">
          <ToggleGroup
            aria-label="Extension kind"
            value={[kind]}
            onValueChange={(next) => {
              const chosen = KINDS.find((entry) => entry === next[0]);
              if (chosen) setKind(chosen);
            }}
          >
            {KINDS.map((entry) => (
              <Toggle key={entry} value={entry}>
                {FORK_KIND_LABELS[entry]} · {matrices.get(entry)!.rows.length}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="flex-1" />
          {answered.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {anyChecking
                ? "checking…"
                : oldestCheck === null
                  ? "not checked yet"
                  : `checked ${formatRelativeTimeLabel(oldestCheck, nowMs)}`}
            </span>
          ) : null}
          {/* A machine already checking ignores the request, so only an all-busy page disables it. */}
          <Button
            size="xs"
            variant="outline"
            disabled={answered.every((machine) => machine.isCheckingHealth)}
            onClick={() => checkHealth()}
          >
            {anyChecking ? <Spinner className="size-3" /> : <RefreshCwIcon aria-hidden />}
            Check status
          </Button>
        </div>
        {statusLines.length > 0 ? (
          <ul className="space-y-0.5 px-3 pt-2 text-xs sm:px-4">
            {statusLines.map((line) => (
              <li
                key={line.key}
                className={line.tone === "warning" ? "text-warning" : "text-muted-foreground"}
              >
                {line.text}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="px-1 pt-2 pb-1 sm:px-2">
          {machines.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Connect an environment to manage its extensions.
            </p>
          ) : columns.length === 0 ? null : rows.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{EMPTY_KIND_LABELS[kind]}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    <span className="sr-only">Name</span>
                  </TableHead>
                  {columns.map((column) => (
                    <TableHead key={column.key} scope="col" className="text-center align-bottom">
                      <ColumnHeader column={column} />
                    </TableHead>
                  ))}
                  <TableHead scope="col" className="text-center">
                    Uses
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const selected = row.item.id === selectedId;
                  const tag = forkSourceTag(row.item);
                  return (
                    <TableRow
                      key={row.item.id}
                      aria-selected={selected}
                      data-state={selected ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(selected ? null : row.item.id)}
                    >
                      <TableCell className="max-w-64">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <button
                            type="button"
                            aria-expanded={selected}
                            className="min-w-0 truncate font-semibold text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(selected ? null : row.item.id);
                            }}
                          >
                            {row.item.name}
                          </button>
                          {tag ? (
                            <span className="shrink-0 text-2xs text-muted-foreground">{tag}</span>
                          ) : null}
                        </span>
                      </TableCell>
                      {columns.map((column, index) => (
                        <TableCell key={column.key} className="text-center">
                          <MatrixCellButton
                            row={row}
                            column={column}
                            cell={row.cells[index]!}
                            pending={pending.has(`${row.item.id}\n${column.key}`)}
                            onClick={() => void clickCell(row, column, row.cells[index]!)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="text-center">{row.usageTotal}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        {columns.length > 0 && rows.length > 0 ? <Legend /> : null}
        {notices.length > 0 ? (
          <div className="space-y-2 px-3 pb-3 sm:px-4">
            {notices.map((notice) => (
              <Alert key={notice.key} variant={notice.tone} controlAlignment="first-line">
                <AlertTitle className="wrap-anywhere">{notice.title}</AlertTitle>
                {notice.problem !== null ? (
                  <AlertDescription>
                    <ForkProblemText problem={notice.problem} />
                  </AlertDescription>
                ) : null}
                <AlertAction>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Dismiss"
                    onClick={() => dropNotice(notice.key)}
                  >
                    <XIcon />
                  </Button>
                </AlertAction>
              </Alert>
            ))}
          </div>
        ) : null}
        {selectedRow !== undefined ? (
          <ForkExtensionsDetail
            key={selectedRow.item.id}
            row={selectedRow}
            columns={columns}
            nowMs={nowMs}
            onInstallHere={onInstallHere}
            onNotices={addNotices}
            renderCellActions={(context) => (
              <ForkAuthorizeButton
                context={context}
                onLogin={(agent) =>
                  authorize.start({
                    environmentId: context.column.environmentId,
                    machineLabel: context.column.machineLabel,
                    agent,
                    itemId: selectedRow.item.id,
                    itemName: selectedRow.item.name,
                  })
                }
              />
            )}
          >
            <ForkPerProjectSection
              row={selectedRow}
              columns={columns}
              onNotices={addNotices}
              onNoticeCleared={dropNotice}
            />
          </ForkExtensionsDetail>
        ) : null}
        {authorize.dialog}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ColumnHeader({ column }: { readonly column: MatrixColumn }) {
  const second =
    column.agent === null
      ? column.support === "needsForkUpdate"
        ? "Needs a fork update"
        : "Offline"
      : column.problem !== null
        ? `${FORK_AGENT_LABELS[column.agent]}: ${column.problem.summary}`
        : FORK_AGENT_LABELS[column.agent];
  return (
    <span className="inline-flex max-w-40 flex-col items-center leading-tight">
      <span className="truncate text-foreground">{column.machineLabel}</span>
      <span
        className={cn(
          "text-2xs font-normal whitespace-normal text-muted-foreground",
          column.problem !== null && "text-warning",
        )}
      >
        {second}
      </span>
      {column.agent !== null && !column.canOperate ? (
        <span className="text-2xs font-normal text-muted-foreground">read-only</span>
      ) : null}
    </span>
  );
}

function StateDot({ state }: { readonly state: MatrixCell["state"] }) {
  switch (state) {
    case "working":
      return <span aria-hidden className="inline-block size-2.5 rounded-full bg-success" />;
    case "unknown":
      return <span aria-hidden className="inline-block size-2.5 rounded-full bg-success/40" />;
    case "needsAttention":
      return <span aria-hidden className="inline-block size-2.5 rounded-full bg-warning" />;
    case "disabled":
      return (
        <span aria-hidden className="inline-block size-2.5 rounded-full bg-muted-foreground/50" />
      );
    case "notInstalled":
      return (
        <span
          aria-hidden
          className="inline-block size-2.5 rounded-full border border-muted-foreground"
        />
      );
    default:
      // The mockup's "—" for n/a, drawn rather than written.
      return <span aria-hidden className="inline-block h-px w-2.5 bg-muted-foreground" />;
  }
}

const ACTION_HINTS = { on: "Click to turn on", off: "Click to turn off" } as const;

function MatrixCellButton({
  row,
  column,
  cell,
  pending,
  onClick,
}: {
  readonly row: MatrixRow;
  readonly column: MatrixColumn;
  readonly cell: MatrixCell;
  readonly pending: boolean;
  readonly onClick: () => void;
}) {
  const action = forkCellAction(
    column,
    cell,
    row.itemsByMachine.get(column.environmentId) ?? row.item,
  );
  const stateLabel = forkCellStateLabel(cell);
  const hint =
    action.kind === "none"
      ? action.reason
      : action.kind === "install"
        ? "Click to install here"
        : ACTION_HINTS[action.enabled ? "on" : "off"];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${row.item.name} on ${forkColumnLabel(column)}: ${stateLabel}`}
            aria-disabled={action.kind === "none" || pending}
            aria-busy={pending}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              action.kind === "none" ? "cursor-default" : "hover:bg-accent",
            )}
            onClick={(event) => {
              // The row's own click opens the detail; a cell acts on itself only.
              event.stopPropagation();
              if (!pending) onClick();
            }}
          >
            {pending ? <Spinner className="size-3" /> : <StateDot state={cell.state} />}
          </button>
        }
      />
      <TooltipPopup>
        {stateLabel}
        {hint === stateLabel ? null : `. ${hint}`}
      </TooltipPopup>
    </Tooltip>
  );
}

function Legend() {
  const entries: ReadonlyArray<readonly [MatrixCell["state"], string]> = [
    ["working", "working"],
    ["needsAttention", "needs attention"],
    ["disabled", "disabled"],
    ["notInstalled", "not installed"],
    ["notApplicable", "n/a"],
  ];
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3 text-2xs text-muted-foreground sm:px-4">
      {entries.map(([state, label]) => (
        <span key={state} className="inline-flex items-center gap-1">
          <StateDot state={state} />
          {label}
        </span>
      ))}
    </p>
  );
}
