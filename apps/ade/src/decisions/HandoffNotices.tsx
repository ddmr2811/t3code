import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { FORK_BOTS_HANDOFF_MAX_HOPS, type EnvironmentId } from "@t3tools/contracts";
import { useContext, useState } from "react";

import { allBotsAtom, forkBotsDismissHandoffCommand, refreshBots } from "../bots/bots.state.ts";
import { runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";

/** Handoffs cut for too many hops wait here until the user opens the sender's thread or dismisses them. */
export function HandoffNotices(props: { onOpenBackLayer: (threadKey: string) => void }) {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { byEnv, handoffsByEnv } = useAtomValue(allBotsAtom);
  const [error, setError] = useState<string | null>(null);

  const notices = [...handoffsByEnv].flatMap(([environmentId, handoffs]) =>
    handoffs
      .filter((handoff) => handoff.status === "cut")
      .map((handoff) => {
        const bots = byEnv.get(environmentId) ?? [];
        return {
          environmentId,
          handoff,
          from: bots.find((bot) => bot.id === handoff.fromBotId),
          to: bots.find((bot) => bot.id === handoff.toBotId),
        };
      }),
  );
  if (notices.length === 0) return null;

  const dismiss = async (environmentId: EnvironmentId, id: string) => {
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsDismissHandoffCommand,
      { environmentId, input: { id } },
      "No se pudo descartar el aviso",
    );
    if (failure !== null) return setError(failure);
    refreshBots(registry, environmentId);
  };

  return (
    <>
      {notices.map(({ environmentId, handoff, from, to }) => (
        <HandoffNotice
          key={`${environmentId}:${handoff.id}`}
          machineLabel={catalog.entries.get(environmentId)?.target.label ?? environmentId}
          title={`Traspaso cortado: @${from?.handle ?? "?"} → @${to?.handle ?? "?"}`}
          preview={handoff.preview}
          hops={handoff.hops}
          environmentId={environmentId}
          onOpen={
            from?.threadId == null
              ? null
              : () =>
                  props.onOpenBackLayer(
                    scopedThreadKey(scopeThreadRef(environmentId, from.threadId!)),
                  )
          }
          onDismiss={() => void dismiss(environmentId, handoff.id)}
        />
      ))}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function HandoffNotice(props: {
  machineLabel: string;
  title: string;
  preview: string;
  hops: number;
  environmentId: EnvironmentId;
  onOpen: (() => void) | null;
  onDismiss: () => void;
}) {
  const canDismiss = useAtomValue(
    forkBotsDismissHandoffCommand.permissionAtom(props.environmentId),
  );
  return (
    <section className="ade-decision" aria-label={props.title}>
      <div className="ade-decision-top">
        <p className="ade-thread-view-meta">{props.machineLabel} · Bots</p>
        <div className="ade-decision-kinds">
          <span className="ade-chip" data-kind="approval">
            Aviso
          </span>
        </div>
      </div>
      <h3>{props.title}</h3>
      <p className="ade-request-note">
        La cadena entre bots llegó a {props.hops} saltos (máximo {FORK_BOTS_HANDOFF_MAX_HOPS}) y no
        se entregó: «{props.preview}». Si hace falta, pásalo tú desde el chat del bot.
      </p>
      <div className="ade-decision-footer">
        {props.onOpen === null ? null : (
          <button type="button" className="ade-backlayer-link" onClick={props.onOpen}>
            <ArrowSquareOutIcon size={15} aria-hidden />
            <span>Abrir el hilo de origen</span>
            <span className="ade-backlayer-hint">Capa trasera</span>
          </button>
        )}
        <button
          type="button"
          className="ade-button-quiet"
          onClick={props.onDismiss}
          disabled={canDismiss !== true}
        >
          Descartar
        </button>
      </div>
    </section>
  );
}
