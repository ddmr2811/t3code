import { useAtomValue } from "@effect/atom-react";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useRef } from "react";

import { assetEnvironment, environmentSession } from "../state.ts";

/**
 * An image the machine serves: its URL is signed per asset and short-lived, minted over the
 * session's socket like T3's own clients do. The bytes load once the image nears the view.
 */
function AssetImage(props: { environmentId: EnvironmentId; resource: AssetResource; alt: string }) {
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
        <AssetImage
          key={image.key}
          environmentId={props.environmentId}
          resource={image.resource}
          alt={image.alt}
        />
      ))}
    </div>
  );
}
