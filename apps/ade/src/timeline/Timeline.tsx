import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  formatSubagentDisplayTitle,
  subagentCardDetail,
} from "@t3tools/client-runtime/state/subagent-display";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { turnChanges, turnHasChanges } from "@t3tools/client-runtime/state/thread-repositories";
import { shouldShowLoadEarlierControl } from "@t3tools/client-runtime/state/threads";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  isOrchestrationV2WorkActive,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { AsyncResult } from "effect/reactivity";
import { memo, type ReactNode, use, useContext, useMemo, useState } from "react";

import { ProviderIcon } from "../composer/ProviderIcon.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import {
  environmentProjects,
  environmentThreadDetails,
  environmentThreadShells,
  orchestrationEnvironment,
  serverEnvironment,
  threadEnvironment,
} from "../state.ts";
import { AgentMarkdown } from "./AgentMarkdown.tsx";
import { tickElapsed } from "./elapsed.ts";
import { MediaStrip, ThreadMedia } from "./Media.tsx";
import {
  formatCount,
  groupTurns,
  liveActivity,
  rowKind,
  subagentElapsedMs,
} from "./timeline.logic.ts";

type Item<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { type: T }
>;
interface RowTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
/** Opens a thread by its scoped key, as the sidebar does. */
type OpenThread = (key: string) => void;

const STATUS_TEXT: Partial<Record<OrchestrationV2TurnItem["status"], string>> = {
  pending: "en cola",
  running: "en curso",
  waiting: "esperando",
  failed: "falló",
  cancelled: "cancelado",
  interrupted: "interrumpido",
};

function toolLabel(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return commandDisplayText(item.input);
    case "file_change": {
      const counts = [
        item.additions ? `+${item.additions}` : null,
        item.deletions ? `−${item.deletions}` : null,
      ].filter((count) => count !== null);
      return [item.fileName, ...counts].join(" ");
    }
    case "file_search":
      return item.title ?? `Buscar ${item.pattern ?? "archivos"}`;
    case "web_search":
      return item.title ?? `Buscar en la web ${item.patterns?.join(", ") ?? ""}`.trim();
    case "dynamic_tool":
      return item.title ?? item.toolName ?? "Herramienta";
    case "subagent":
      return item.title ?? "Subagente";
    default:
      return item.title ?? item.type;
  }
}

function localOutput(item: OrchestrationV2TurnItem): string | null {
  if (item.type === "file_change") return item.diffStr ?? null;
  if (item.type === "subagent") return item.result ?? item.progress ?? null;
  return turnItemOutputText(item);
}

function outputImages(item: OrchestrationV2TurnItem, workspaceRoot: string | null) {
  const images = turnItemOutputImages(item).map((resource) => ({
    key: String(resource.index),
    resource,
    alt: `imagen ${resource.index + 1} de ${toolLabel(item)}`,
  }));
  // Some providers (Codex) record only the path of an image the agent opened, not its bytes.
  const viewed =
    images.length === 0 && item.type === "dynamic_tool" && item.viewedImagePath !== undefined
      ? resolveViewedImageAsset(item.viewedImagePath, { threadId: item.threadId, workspaceRoot })
      : null;
  return viewed === null ? images : [{ key: "viewed", resource: viewed.resource, alt: viewed.alt }];
}

// A file read as an image has only the file's metadata as text: the image says it all.
const showsOnlyImages = (item: OrchestrationV2TurnItem, images: ReadonlyArray<unknown>) =>
  item.type === "dynamic_tool" && item.viewedImagePath !== undefined && images.length > 0;

/** Collapsed until opened; its content renders only while open, so closed rows stay cheap. */
function Fold(props: { className: string; summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={props.className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{props.summary}</summary>
      {open ? props.children() : null}
    </details>
  );
}

function OutputText(props: { text: string | null }) {
  return props.text === null || props.text.trim() === "" ? (
    <p className="ade-tool-empty">Sin salida.</p>
  ) : (
    <pre className="ade-tool-output">{props.text}</pre>
  );
}

function ToolOutput(props: RowTarget & { item: OrchestrationV2TurnItem }) {
  const images = outputImages(props.item, use(ThreadMedia)?.workspaceRoot ?? null);
  return (
    <>
      <MediaStrip environmentId={props.environmentId} images={images} />
      {showsOnlyImages(props.item, images) ? null : <OutputText text={localOutput(props.item)} />}
    </>
  );
}

// The snapshot leaves long outputs out; the row asks the server once it is opened.
function FetchedOutput(props: RowTarget & { item: OrchestrationV2TurnItem }) {
  const result = useAtomValue(
    orchestrationEnvironment.turnItem({
      environmentId: props.environmentId,
      input: {
        threadId: props.item.threadId,
        itemId: props.item.id,
        revision: turnItemDetailRevision(props.item),
      },
    }),
  );
  if (AsyncResult.isFailure(result)) {
    return <p className="ade-tool-empty">No se pudo cargar la salida.</p>;
  }
  const fetched = AsyncResult.getOrElse(result, () => null);
  if (fetched === null) return <p className="ade-tool-empty">Cargando la salida…</p>;
  return fetched.item === null ? (
    <OutputText text={null} />
  ) : (
    <ToolOutput environmentId={props.environmentId} threadId={props.threadId} item={fetched.item} />
  );
}

function ToolRow(props: RowTarget & { item: OrchestrationV2TurnItem }) {
  const status = STATUS_TEXT[props.item.status];
  const images = outputImages(props.item, use(ThreadMedia)?.workspaceRoot ?? null);
  // An image the agent opened shows in the timeline, as in T3; there is nothing else to open.
  if (showsOnlyImages(props.item, images)) {
    return (
      <div className="ade-tool ade-tool-viewed">
        <span className="ade-tool-label">{toolLabel(props.item)}</span>
        <MediaStrip environmentId={props.environmentId} images={images} />
      </div>
    );
  }
  return (
    <Fold
      className="ade-tool"
      summary={
        <>
          <span className="ade-tool-label">{toolLabel(props.item)}</span>
          {status === undefined ? null : (
            <span className="ade-tool-status" data-status={props.item.status}>
              {status}
            </span>
          )}
        </>
      }
    >
      {() =>
        turnItemNeedsDetailFetch(props.item) ? (
          <FetchedOutput {...props} />
        ) : (
          <ToolOutput {...props} />
        )
      }
    </Fold>
  );
}

const SUBAGENT_STATUS: Record<OrchestrationV2TurnItem["status"], string> = {
  pending: "En marcha",
  running: "En marcha",
  waiting: "Esperando",
  idle: "En pausa",
  completed: "Terminado",
  failed: "Falló",
  cancelled: "Cancelado",
  interrupted: "Cancelado",
};

/** A subagent or delegated task, as T3 shows it: who runs it, how it goes, and a way into it. */
function SubagentCard(props: RowTarget & { item: Item<"subagent">; onOpenThread: OpenThread }) {
  const { item } = props;
  const provider = useAtomValue(
    serverEnvironment.configValueAtom(props.environmentId),
    (config) =>
      config?.providers.find((candidate) => candidate.instanceId === item.providerInstanceId) ??
      null,
  );
  // A task delegated to another machine opens there, when this ADE is paired with it.
  const target =
    item.childThreadId !== null
      ? scopeThreadRef(props.environmentId, item.childThreadId)
      : item.remoteChild === undefined
        ? null
        : scopeThreadRef(item.remoteChild.environmentId, item.remoteChild.threadId);
  const reachable = useAtomValue(
    environmentCatalog.catalogValueAtom,
    (catalog) => target !== null && catalog.entries.has(target.environmentId),
  );
  const title = formatSubagentDisplayTitle(item.title?.trim() || "Subagente");
  const status = SUBAGENT_STATUS[item.status];
  const live = isOrchestrationV2WorkActive(item.status);
  const detail = subagentCardDetail(
    live ? item.progress || item.result : item.result || item.progress,
  );
  const content = (
    <>
      <ProviderIcon
        provider={{
          driver: item.driver,
          instanceId: item.providerInstanceId,
          label: provider?.displayName ?? PROVIDER_DISPLAY_NAMES[item.driver] ?? item.driver,
          accentColor: provider?.accentColor,
        }}
      />
      <span className="ade-subagent-text">
        <span className="ade-subagent-title">
          {title}
          {item.remoteChild === undefined ? null : (
            <span className="ade-subagent-where"> en {item.remoteChild.label}</span>
          )}
        </span>
        <span className="ade-subagent-status" data-status={item.status}>
          {detail === null ? status : `${status} · ${detail}`}
        </span>
      </span>
      <span
        className="ade-subagent-time"
        ref={tickElapsed((nowMs) => subagentElapsedMs(item, nowMs), live)}
      />
    </>
  );
  if (target === null || !reachable) return <div className="ade-subagent">{content}</div>;
  return (
    <button
      type="button"
      className="ade-subagent"
      aria-label={`Abrir ${title}: ${status}`}
      onClick={() => props.onOpenThread(scopedThreadKey(target))}
    >
      {content}
      <CaretRightIcon size={14} aria-hidden className="ade-subagent-open" />
    </button>
  );
}

function StreamingText(props: RowTarget & { item: Item<"assistant_message"> }) {
  const text = useAtomValue(
    environmentThreadDetails.assistantMessageTextAtom(
      scopeThreadRef(props.environmentId, props.threadId),
      props.item.id,
    ),
  );
  return <AgentMarkdown text={text ?? props.item.text} />;
}

function DeferredWork(props: RowTarget & { row: OrchestrationV2ProjectedTurnItem }) {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const count = props.row.item.deferredWork?.itemCount ?? 0;
  const load = () => {
    setState("loading");
    void runAtomCommand(
      registry,
      threadEnvironment.loadEarlierHistory,
      {
        environmentId: props.environmentId,
        input: { threadId: props.threadId, workAnchorId: props.row.sourceItemId },
      },
      { reportFailure: false },
    ).then((result) =>
      setState(result._tag === "Failure" || result.value._tag === "error" ? "failed" : "idle"),
    );
  };
  return (
    <button
      type="button"
      className="ade-timeline-more"
      disabled={state === "loading"}
      onClick={load}
    >
      {state === "loading"
        ? "Cargando…"
        : state === "failed"
          ? "No se pudo cargar. Reintentar"
          : `Ver ${count} ${count === 1 ? "paso oculto" : "pasos ocultos"}`}
    </button>
  );
}

function UserMessage(props: RowTarget & { item: Item<"user_message"> }) {
  // The agent needs words to start a turn; the user sent only the attachments.
  const text = isAttachmentOnlyBootstrapPrompt(props.item.text) ? "" : props.item.text;
  const images = props.item.attachments.flatMap((attachment) =>
    attachment.type === "image"
      ? [
          {
            key: attachment.id,
            resource: { _tag: "attachment" as const, attachmentId: attachment.id },
            alt: attachment.name,
          },
        ]
      : [],
  );
  return (
    <div className="ade-msg-user">
      <MediaStrip environmentId={props.environmentId} images={images} />
      {text === "" ? null : <p className="ade-msg-user-text">{text}</p>}
    </div>
  );
}

// Rows keep their object while unchanged, so only the row whose item moved renders again.
const TimelineRow = memo(function TimelineRow(
  props: RowTarget & { row: OrchestrationV2ProjectedTurnItem; onOpenThread: OpenThread },
) {
  const { item } = props.row;
  const deferred =
    item.deferredWork === undefined ? null : <DeferredWork {...props} row={props.row} />;
  switch (rowKind(item)) {
    case "user":
      return (
        <>
          {deferred}
          {item.type === "user_message" ? <UserMessage {...props} item={item} /> : null}
        </>
      );
    case "assistant":
      if (item.type !== "assistant_message") return deferred;
      return (
        <>
          {deferred}
          <div className="ade-msg-agent">
            {item.streaming ? (
              <StreamingText {...props} item={item} />
            ) : (
              <AgentMarkdown text={item.text} />
            )}
          </div>
        </>
      );
    case "reasoning":
      return (
        <>
          {deferred}
          <Fold className="ade-reasoning" summary="Razonamiento">
            {() => <AgentMarkdown text={item.type === "reasoning" ? item.text : ""} />}
          </Fold>
        </>
      );
    case "tool":
      return (
        <>
          {deferred}
          {item.type === "subagent" ? (
            <SubagentCard {...props} item={item} />
          ) : (
            <ToolRow {...props} item={item} />
          )}
        </>
      );
    case "notice":
      return (
        <>
          {deferred}
          <p className="ade-notice">
            {item.type === "system_notice"
              ? item.message
              : item.type === "compaction"
                ? "Contexto compactado"
                : null}
          </p>
        </>
      );
    case "error":
      return (
        <>
          {deferred}
          <p className="ade-error" role="alert">
            {item.type === "error" ? item.failure.message : null}
          </p>
        </>
      );
    case null:
      return deferred;
  }
});

function EarlierHistory(props: RowTarget) {
  const registry = useContext(RegistryContext);
  const history = useAtomValue(
    environmentThreadDetails.historyAtom(scopeThreadRef(props.environmentId, props.threadId)),
  );
  if (!shouldShowLoadEarlierControl(history)) return null;
  const load = () =>
    void runAtomCommand(
      registry,
      threadEnvironment.loadEarlierHistory,
      { environmentId: props.environmentId, input: { threadId: props.threadId } },
      { reportFailure: false },
    );
  return (
    <li className="ade-turn ade-turn-history">
      <button type="button" className="ade-timeline-more" disabled={history.loading} onClick={load}>
        {history.loading ? "Cargando…" : "Cargar mensajes anteriores"}
      </button>
      {history.error === null ? null : (
        <p className="ade-error" role="alert">
          {history.error}
        </p>
      )}
    </li>
  );
}

/** What a turn changed, from its checkpoint; the diff itself is asked for once this is opened. */
function TurnChanges(props: {
  checkpoint: ThreadCheckpointSummary;
  onOpen: (checkpoint: ThreadCheckpointSummary) => void;
}) {
  const { count, additions, deletions } = turnChanges(props.checkpoint).totals;
  return (
    <button
      type="button"
      className="ade-turn-changes"
      onClick={() => props.onOpen(props.checkpoint)}
    >
      {count} {count === 1 ? "fichero" : "ficheros"} ·{" "}
      <span data-sign="+">+{formatCount(additions)}</span>{" "}
      <span data-sign="−">−{formatCount(deletions)}</span>
    </button>
  );
}

/** What the agent is doing now, where the conversation ends; gone once nothing is. */
function LiveActivityRow(props: { threadRef: ScopedThreadRef }) {
  // The quiet thread keeps its value while replies stream, so tokens re-render nothing here.
  const thread = useAtomValue(environmentThreadDetails.quietThreadAtom(props.threadRef));
  const now = thread === null ? null : liveActivity(thread.projection);
  return (
    <li className="ade-live" role="status">
      {now === null ? null : <p className="ade-live-line">{now}</p>}
    </li>
  );
}

/** The thread's turns, read only. Streamed text renders inside its own row. */
export function ThreadTimeline(props: {
  threadRef: ScopedThreadRef;
  onOpenChanges: (checkpoint: ThreadCheckpointSummary) => void;
  onOpenThread: OpenThread;
  /** What the agent waits on, shown where it stopped: after the last turn. */
  requests: ReactNode;
}) {
  const { environmentId, threadId } = props.threadRef;
  const rows = useAtomValue(environmentThreadDetails.timelineVisibleTurnItemsAtom(props.threadRef));
  const checkpoints = useAtomValue(
    environmentThreadDetails.checkpointSummariesAtom(props.threadRef),
  );
  const checkpointByRun = new Map<string, ThreadCheckpointSummary>(
    checkpoints.filter(turnHasChanges).map((checkpoint) => [checkpoint.runId, checkpoint]),
  );
  const status = useAtomValue(environmentThreadDetails.statusAtom(props.threadRef));
  const error = useAtomValue(environmentThreadDetails.errorAtom(props.threadRef));
  const thread = useAtomValue(environmentThreadShells.quietThreadShellAtom(props.threadRef));
  const projectRoot = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(environmentId),
    (index) => (thread === null ? null : (index.get(thread.projectId)?.workspaceRoot ?? null)),
  );
  // Relative paths in replies are the thread's worktree's, or its project's without one.
  const workspaceRoot = thread?.worktreePath ?? projectRoot;
  const media = useMemo(
    () => ({ environmentId, threadId, workspaceRoot }),
    [environmentId, threadId, workspaceRoot],
  );
  const turns = groupTurns(rows);
  if (turns.length === 0) {
    return (
      <>
        <p className="ade-timeline-empty" role={error === null ? "status" : "alert"}>
          {status === "deleted"
            ? "Este hilo se ha borrado."
            : (error ??
              (status === "live" ? "Este hilo aún no tiene mensajes." : "Cargando el historial…"))}
        </p>
        <div className="ade-requests-outside">{props.requests}</div>
      </>
    );
  }
  return (
    // column-reverse keeps the view pinned to the newest turn as rows grow, with no scroll code.
    <div className="ade-timeline-scroll">
      <ThreadMedia value={media}>
        <ol className="ade-timeline" aria-label="Conversación">
          <EarlierHistory environmentId={environmentId} threadId={threadId} />
          {turns.map((turn) => {
            const checkpoint = turn.runId === null ? undefined : checkpointByRun.get(turn.runId);
            return (
              <li key={turn.key} className="ade-turn">
                {turn.rows.map((row) => (
                  <TimelineRow
                    key={row.item.id}
                    environmentId={environmentId}
                    threadId={threadId}
                    row={row}
                    onOpenThread={props.onOpenThread}
                  />
                ))}
                {checkpoint === undefined ? null : (
                  <TurnChanges checkpoint={checkpoint} onOpen={props.onOpenChanges} />
                )}
              </li>
            );
          })}
          <LiveActivityRow threadRef={props.threadRef} />
          <li className="ade-turn-requests">{props.requests}</li>
        </ol>
      </ThreadMedia>
    </div>
  );
}
