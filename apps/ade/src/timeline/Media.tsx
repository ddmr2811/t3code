import { useAtomValue } from "@effect/atom-react";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { createContext, use, useRef } from "react";

import { assetEnvironment, environmentSession, filesAccessAtom } from "../state.ts";

type MediaKind = "image" | "video";

// Pairings made before the ADE asked for filesystem:read.
const NO_FILES_ACCESS = "Vuelve a emparejar la máquina para verla.";

/**
 * A file the machine serves: its URL is signed per asset and short-lived, minted over the
 * session's socket like T3's own clients do. The bytes load once the media nears the view.
 */
function AssetMediaLoaded(props: {
  environmentId: EnvironmentId;
  resource: AssetResource;
  kind: MediaKind;
  alt: string;
}) {
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId: props.environmentId,
      input: { resource: props.resource },
    }),
  );
  const connection = useAtomValue(
    environmentSession.preparedConnectionValueAtom(props.environmentId),
  );
  const state = assetUrlStateFromResult(
    result,
    Option.isSome(connection) ? connection.value.httpBaseUrl : null,
  );
  const viewer = useRef<HTMLDialogElement>(null);
  if (state._tag === "Failure") {
    return <span className="ade-media-missing">[imagen no disponible: {props.alt}]</span>;
  }
  if (state._tag === "Loading") {
    return <span className="ade-media-loading" role="img" aria-label={`Cargando ${props.alt}`} />;
  }
  if (props.kind === "video") {
    return (
      <video className="ade-media-video" src={state.url} controls preload="none">
        {props.alt}
      </video>
    );
  }
  return (
    <>
      <button
        type="button"
        className="ade-media"
        aria-label={`Ampliar ${props.alt}`}
        onClick={() => viewer.current?.showModal()}
      >
        <img src={state.url} alt={props.alt} loading="lazy" decoding="async" />
      </button>
      {/* A click anywhere, or Escape, closes it. */}
      <dialog
        ref={viewer}
        className="ade-media-viewer"
        aria-label={props.alt}
        onClick={(event) => event.currentTarget.close()}
      >
        <img src={state.url} alt={props.alt} />
      </dialog>
    </>
  );
}

/** Files on the machine need `filesystem:read`; an older pairing shows their name instead. */
function AssetMedia(props: {
  environmentId: EnvironmentId;
  resource: AssetResource;
  kind: MediaKind;
  alt: string;
}) {
  const canReadFiles = useAtomValue(filesAccessAtom(props.environmentId));
  if (props.resource._tag !== "media-file" || canReadFiles === true) {
    return <AssetMediaLoaded {...props} />;
  }
  if (canReadFiles === null) {
    return <span className="ade-media-loading" role="img" aria-label={`Cargando ${props.alt}`} />;
  }
  return (
    <span className="ade-md-image">
      [{props.kind === "video" ? "vídeo" : "imagen"}: {props.alt}]{" "}
      <span className="ade-media-missing">{NO_FILES_ACCESS}</span>
    </span>
  );
}

export function MediaStrip(props: {
  environmentId: EnvironmentId;
  images: ReadonlyArray<{
    readonly key: string;
    readonly resource: AssetResource;
    readonly alt: string;
  }>;
}) {
  if (props.images.length === 0) return null;
  return (
    <div className="ade-media-strip">
      {props.images.map((image) => (
        <AssetMedia
          key={image.key}
          environmentId={props.environmentId}
          resource={image.resource}
          kind="image"
          alt={image.alt}
        />
      ))}
    </div>
  );
}

/** The thread whose files a reply's paths name; null outside a thread's timeline. */
export const ThreadMedia = createContext<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
} | null>(null);

/** An image or video a reply names by path, served by the machine as T3 shows it. */
export function MarkdownMedia(props: { src: string | undefined; alt: string }) {
  const thread = use(ThreadMedia);
  const media =
    thread === null || props.src === undefined
      ? null
      : resolveMediaSource(props.src, {
          threadId: thread.threadId,
          workspaceRoot: thread.workspaceRoot,
          imageEmbed: true,
        });
  // Web images stay text: the CSP loads images only from the paired machines.
  if (thread === null || media === null || media.access !== "environment") {
    return <span className="ade-md-image">[imagen{props.alt ? `: ${props.alt}` : ""}]</span>;
  }
  return (
    <AssetMedia
      environmentId={thread.environmentId}
      resource={media.resource}
      kind={media.kind}
      alt={props.alt || media.name}
    />
  );
}
