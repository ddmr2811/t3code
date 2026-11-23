// The sidecars a machine's owner declared for the extension gateway, and the one panel open.
// A panel opens in a sandboxed frame: the gateway serves it with an opaque origin, and the frame
// cannot reach this page, its storage, or its DPoP key either.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ForkGatewayList, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime.ts";
import { environmentSession, gatewayAccessAtom } from "../state.ts";

const extensionsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "ade:fork-gateway:list",
  tag: WS_METHODS.forkGatewayList,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});

interface PanelTarget {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly panelPath: string;
}

const openPanelAtom = Atom.make<(PanelTarget & { readonly url: string }) | null>(null).pipe(
  Atom.keepAlive,
);

const panelTicket = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-gateway:panel-ticket",
  tag: WS_METHODS.forkGatewayPanelTicket,
});

/**
 * A frame cannot send DPoP, so its address carries a ticket the gateway takes for this extension
 * alone, for minutes, and strips before the sidecar.
 */
async function openPanel(registry: AtomRegistry.AtomRegistry, target: PanelTarget) {
  const prepared = Option.getOrNull(
    registry.get(environmentSession.preparedConnectionValueAtom(target.environmentId)),
  );
  if (prepared === null) return;
  const result = await runAtomCommand(registry, panelTicket, {
    environmentId: target.environmentId,
    input: { id: target.id },
  });
  if (!AsyncResult.isSuccess(result)) return;
  const path = `/api/fork/ext/${target.id}${target.panelPath}`;
  const ticket = encodeURIComponent(result.value.ticket);
  registry.set(openPanelAtom, {
    ...target,
    url: `${environmentEndpointUrl(prepared.httpBaseUrl, path)}?wsTicket=${ticket}`,
  });
}

function ExtensionList(props: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const list = AsyncResult.getOrElse(
    useAtomValue(extensionsQuery({ environmentId: props.environmentId, input: {} })),
    (): ForkGatewayList | null => null,
  );
  if (list === null) return null;
  if (list.problem !== undefined) {
    return (
      <p className="ade-extensions-problem">Manifiesto de extensiones rechazado: {list.problem}</p>
    );
  }
  if (list.extensions.length === 0) return null;
  return (
    <ul className="ade-extensions">
      {list.extensions.map(({ id, title, panelPath }) => (
        <li key={id}>
          <span>{title ?? id}</span>
          {panelPath !== undefined && (
            <button
              type="button"
              className="ade-button-quiet"
              onClick={() =>
                void openPanel(registry, {
                  environmentId: props.environmentId,
                  id,
                  title: title ?? id,
                  panelPath,
                })
              }
            >
              Abrir panel
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Nothing unless this ADE's session was granted the gateway on that machine. */
export function MachineExtensions(props: { environmentId: EnvironmentId }) {
  return useAtomValue(gatewayAccessAtom(props.environmentId)) ? (
    <ExtensionList environmentId={props.environmentId} />
  ) : null;
}

export function ExtensionPanel() {
  const registry = useContext(RegistryContext);
  const panel = useAtomValue(openPanelAtom);
  if (panel === null) return null;
  return (
    <section className="ade-extension-panel">
      <header>
        <h2>{panel.title}</h2>
        {/* The ticket in the address lasts minutes, so a reload asks for a fresh one. */}
        <button
          type="button"
          className="ade-button-quiet"
          onClick={() => void openPanel(registry, panel)}
        >
          Recargar
        </button>
        <button
          type="button"
          className="ade-button-quiet"
          onClick={() => registry.set(openPanelAtom, null)}
        >
          Cerrar
        </button>
      </header>
      <iframe
        key={panel.url}
        title={panel.title}
        src={panel.url}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
