import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
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
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { AsyncResult } from "effect/reactivity";
import { memo, type ReactNode, use, useContext, useMemo, useState } from "react";

import {
  environmentProjects,
  environmentThreadDetails,
  environmentThreadShells,
  orchestrationEnvironment,
  threadEnvironment,
} from "../state.ts";
import { AgentMarkdown } from "./AgentMarkdown.tsx";
import { MediaStrip, ThreadMedia } from "./Media.tsx";
import { formatCount, groupTurns, rowKind } from "./timeline.logic.ts";

type Item<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { type: T }
>;
interface RowTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

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
  props: RowTarget & { row: OrchestrationV2ProjectedTurnItem },
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
          <ToolRow {...props} item={item} />
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

/** The thread's turns, read only. Streamed text renders inside its own row. */
export function ThreadTimeline(props: {
  threadRef: ScopedThreadRef;
  onOpenChanges: (checkpoint: ThreadCheckpointSummary) => void;
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
      <p className="ade-timeline-empty" role={error === null ? "status" : "alert"}>
        {status === "deleted"
          ? "Este hilo se ha borrado."
          : (error ??
            (status === "live" ? "Este hilo aún no tiene mensajes." : "Cargando el historial…"))}
      </p>
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
                  />
                ))}
                {checkpoint === undefined ? null : (
                  <TurnChanges checkpoint={checkpoint} onOpen={props.onOpenChanges} />
                )}
              </li>
            );
          })}
          <li className="ade-turn-requests">{props.requests}</li>
        </ol>
      </ThreadMedia>
    </div>
  );
}
