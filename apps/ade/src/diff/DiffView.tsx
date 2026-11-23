import { useAtomValue } from "@effect/atom-react";
import { FileDiff } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import { orchestrationEnvironment } from "../state.ts";
import { formatCount } from "../timeline/timeline.logic.ts";
import { type DiffFile, diffFiles } from "./diff.logic.ts";

export interface DiffRange {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly title: string;
}

function diffAtom(threadRef: ScopedThreadRef, range: DiffRange) {
  const { environmentId, threadId } = threadRef;
  // From the start, the server answers the thread diff; a range from 0 is the same patch.
  return range.fromTurnCount === 0
    ? orchestrationEnvironment.fullThreadDiff({
        environmentId,
        input: { threadId, toTurnCount: range.toTurnCount },
      })
    : orchestrationEnvironment.turnDiff({
        environmentId,
        input: { threadId, fromTurnCount: range.fromTurnCount, toTurnCount: range.toTurnCount },
      });
}

const fileAnchor = (file: DiffFile) => `ade-diff-${encodeURIComponent(file.key)}`;

function Counts(props: { additions: number; deletions: number }) {
  return (
    <span className="ade-diff-counts">
      <span data-sign="+">+{formatCount(props.additions)}</span>{" "}
      <span data-sign="−">−{formatCount(props.deletions)}</span>
    </span>
  );
}

function FileBody(props: { file: DiffFile }) {
  const [forced, setForced] = useState(false);
  if (props.file.kind === "empty") {
    return <p className="ade-diff-note">Sin líneas que mostrar: binario, renombrado o permisos.</p>;
  }
  if (props.file.kind === "large" && !forced) {
    return (
      <p className="ade-diff-note">
        Fichero grande: {formatCount(props.file.fileDiff.unifiedLineCount)} líneas.{" "}
        <button type="button" className="ade-timeline-more" onClick={() => setForced(true)}>
          Mostrar igualmente
        </button>
      </p>
    );
  }
  return (
    <FileDiff
      fileDiff={props.file.fileDiff}
      disableWorkerPool
      options={{
        diffStyle: "unified",
        disableFileHeader: true,
        lineDiffType: "none",
        overflow: "wrap",
        theme: "pierre-dark",
        themeType: "dark",
      }}
    />
  );
}

/** One turn's or the whole thread's changes, asked for only while this view is open. */
export default function DiffView(props: {
  threadRef: ScopedThreadRef;
  range: DiffRange;
  onClose: () => void;
}) {
  const result = useAtomValue(diffAtom(props.threadRef, props.range));
  const data = AsyncResult.getOrElse(result, () => null);
  const parsed = useMemo(() => (data === null ? null : diffFiles(data)), [data]);
  return (
    <section className="ade-diff" aria-label="Cambios">
      <header className="ade-diff-header">
        <h2>{props.range.title}</h2>
        <button type="button" className="ade-button-quiet" onClick={props.onClose}>
          Volver a la conversación
        </button>
      </header>
      {AsyncResult.isFailure(result) ? (
        <p className="ade-error" role="alert">
          No se pudo cargar el diff.
        </p>
      ) : parsed === null ? (
        <p className="ade-diff-note" role="status">
          Cargando el diff…
        </p>
      ) : parsed.files.length === 0 ? (
        <p className="ade-diff-note">Sin cambios en ficheros.</p>
      ) : (
        <div className="ade-diff-body">
          {parsed.truncated ? (
            <p className="ade-diff-note" role="status">
              El servidor recortó este diff por tamaño: faltan ficheros o líneas al final.
            </p>
          ) : null}
          <nav aria-label="Ficheros cambiados">
            <ul className="ade-diff-list">
              {parsed.files.map((file) => (
                <li key={file.key}>
                  <button
                    type="button"
                    onClick={() =>
                      document.getElementById(fileAnchor(file))?.scrollIntoView({ block: "start" })
                    }
                  >
                    {file.path}
                  </button>
                  <Counts additions={file.additions} deletions={file.deletions} />
                </li>
              ))}
            </ul>
          </nav>
          {parsed.files.map((file) => (
            <article
              key={file.key}
              id={fileAnchor(file)}
              className="ade-diff-file"
              aria-label={file.path}
            >
              <h3>
                <span>{file.path}</span>
                <Counts additions={file.additions} deletions={file.deletions} />
              </h3>
              <FileBody file={file} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
