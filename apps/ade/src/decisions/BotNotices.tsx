import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  FORK_BOTS_HANDOFF_MAX_HOPS,
  type EnvironmentId,
  type ForkBot,
  type ForkBotHandoff,
  type ForkBotProposal,
} from "@t3tools/contracts";
import { type ReactNode, useContext, useState } from "react";

import {
  allBotsAtom,
  forkBotsAnswerProposalCommand,
  forkBotsDismissHandoffCommand,
  refreshBots,
} from "../bots/bots.state.ts";
import { RUNTIME_MODE_TEXT, runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { environmentProjects, serverEnvironment } from "../state.ts";
import { focusTrayFrom } from "./Requests.tsx";

type BotNotice = {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
} & (
  | { readonly type: "handoff"; readonly handoff: ForkBotHandoff; readonly from?: ForkBot }
  | { readonly type: "proposal"; readonly proposal: ForkBotProposal; readonly from?: ForkBot }
);

/**
 * What the bots wait on the user for, on every machine, keyed like the decisions panel counts
 * them: handoffs cut for too many hops and bots a coordinator proposes.
 */
export function useBotNotices(): ReadonlyArray<BotNotice> {
  const { byEnv, handoffsByEnv, proposalsByEnv } = useAtomValue(allBotsAtom);
  const botOf = (environmentId: EnvironmentId, id: string) =>
    (byEnv.get(environmentId) ?? []).find((bot) => bot.id === id);
  const handoffs = [...handoffsByEnv].flatMap(([environmentId, list]) =>
    list
      .filter((handoff) => handoff.status === "cut")
      .map((handoff): BotNotice => {
        const from = botOf(environmentId, handoff.fromBotId);
        const to = botOf(environmentId, handoff.toBotId);
        return {
          key: `handoff:${environmentId}:${handoff.id}`,
          type: "handoff",
          label: "Aviso",
          title: `Traspaso cortado: @${from?.handle ?? "?"} → @${to?.handle ?? "?"}`,
          environmentId,
          handoff,
          ...(from === undefined ? {} : { from }),
        };
      }),
  );
  const proposals = [...proposalsByEnv].flatMap(([environmentId, list]) =>
    list
      .filter((proposal) => proposal.status === "pending")
      .map((proposal): BotNotice => {
        const from = botOf(environmentId, proposal.proposedBy);
        return {
          key: `proposal:${environmentId}:${proposal.id}`,
          type: "proposal",
          label: "Bot nuevo",
          title: `¿Creo el bot ${proposal.name} (@${proposal.handle})?`,
          environmentId,
          proposal,
          ...(from === undefined ? {} : { from }),
        };
      }),
  );
  return [...proposals, ...handoffs];
}

/**
 * Bot notices wait here until the user answers them or opens the sender's thread. `include`
 * picks the ones to show: the tray's current one, or those not snoozed.
 */
export function BotNotices(props: {
  onOpenBackLayer: (threadKey: string) => void;
  include: (key: string) => boolean;
  /** The one-at-a-time tray's «Luego»; the list passes `onLater` and each notice gets its own. */
  later?: ReactNode;
  onLater?: (key: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [error, setError] = useState<string | null>(null);
  // Sent once: the notice leaves when the bots refresh, so a sent key stays disabled.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const notices = useBotNotices().filter((notice) => props.include(notice.key));
  if (notices.length === 0) return null;

  const send = async (
    key: string,
    environmentId: EnvironmentId,
    run: () => Promise<string | null>,
  ) => {
    if (sending.has(key)) return;
    setSending((current) => new Set(current).add(key));
    setError(null);
    const failure = await run();
    if (failure !== null) {
      setSending((current) => new Set([...current].filter((sent) => sent !== key)));
      return setError(failure);
    }
    refreshBots(registry, environmentId);
  };

  return (
    <>
      {notices.map((notice) => {
        const { key, environmentId, from } = notice;
        const common = {
          machineLabel: catalog.entries.get(environmentId)?.target.label ?? environmentId,
          title: notice.title,
          later:
            props.onLater === undefined ? (
              props.later
            ) : (
              <button
                type="button"
                className="ade-button-quiet"
                onClick={() => props.onLater?.(key)}
              >
                Luego
              </button>
            ),
          environmentId,
          sending: sending.has(key),
          // A coordinator moved to another project no longer speaks for this proposal.
          onOpen:
            from?.threadId == null ||
            (notice.type === "proposal" &&
              (!from.coordinator || from.projectId !== notice.proposal.projectId))
              ? null
              : () =>
                  props.onOpenBackLayer(
                    scopedThreadKey(scopeThreadRef(environmentId, from.threadId!)),
                  ),
        };
        if (notice.type === "proposal") {
          const answer = (value: "accept" | "reject") =>
            void send(key, environmentId, () =>
              runCommand(
                registry,
                forkBotsAnswerProposalCommand,
                { environmentId, input: { id: notice.proposal.id, answer: value } },
                value === "accept" ? "No se pudo crear el bot" : "No se pudo guardar el «No»",
              ),
            );
          return (
            <ProposalNotice
              key={key}
              {...common}
              proposal={notice.proposal}
              coordinator={from}
              onAnswer={answer}
            />
          );
        }
        return (
          <HandoffNotice
            key={key}
            {...common}
            preview={notice.handoff.preview}
            hops={notice.handoff.hops}
            onDismiss={() =>
              void send(key, environmentId, () =>
                runCommand(
                  registry,
                  forkBotsDismissHandoffCommand,
                  { environmentId, input: { id: notice.handoff.id } },
                  "No se pudo descartar el aviso",
                ),
              )
            }
          />
        );
      })}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface NoticeProps {
  machineLabel: string;
  title: string;
  environmentId: EnvironmentId;
  onOpen: (() => void) | null;
  sending: boolean;
  later?: ReactNode;
}

function NoticeFrame(
  props: NoticeProps & {
    label: string;
    context: ReactNode;
    openLabel: string;
    heading?: ReactNode;
    children: ReactNode;
    actions: ReactNode;
  },
) {
  return (
    <section className="ade-decision" aria-label={props.title}>
      <div className="ade-decision-top">
        <p className="ade-thread-view-meta">
          {props.machineLabel} · {props.context}
        </p>
        <div className="ade-decision-kinds">
          <span className="ade-chip" data-kind="approval">
            {props.label}
          </span>
        </div>
      </div>
      <h3>{props.heading ?? props.title}</h3>
      {props.children}
      <div className="ade-decision-footer ade-decision-answers">{props.actions}</div>
      <div className="ade-decision-footer">
        {props.onOpen === null ? null : (
          <button type="button" className="ade-backlayer-link" onClick={props.onOpen}>
            <ArrowSquareOutIcon size={15} aria-hidden />
            <span>{props.openLabel}</span>
            <span className="ade-backlayer-hint">Capa trasera</span>
          </button>
        )}
        {props.later}
      </div>
    </section>
  );
}

function ProposalNotice(
  props: NoticeProps & {
    proposal: ForkBotProposal;
    coordinator: ForkBot | undefined;
    onAnswer: (answer: "accept" | "reject") => void;
  },
) {
  const canAnswer = useAtomValue(forkBotsAnswerProposalCommand.permissionAtom(props.environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const { proposal } = props;
  const projectTitle = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(props.environmentId),
    (index) => index.get(proposal.projectId)?.title ?? null,
  );
  const model = availableMachineModelOptions(config).find(
    (option) =>
      option.instanceId === proposal.modelSelection.instanceId &&
      option.model === proposal.modelSelection.model,
  );
  const disabled = canAnswer !== true || props.sending;
  return (
    <NoticeFrame
      {...props}
      heading={
        <>
          ¿Creo el bot {proposal.name} (<span className="ade-nowrap">@{proposal.handle}</span>)?
        </>
      }
      label="Bot nuevo"
      context={projectTitle ?? "Proyecto sin nombre"}
      openLabel="Abrir el hilo del coordinador"
      actions={
        <>
          <button
            type="button"
            className="ade-button"
            data-agent-confirm
            onClick={(event) => {
              focusTrayFrom(event.currentTarget);
              props.onAnswer("accept");
            }}
            disabled={disabled}
          >
            {props.sending ? "Enviando…" : "Créalo"}
          </button>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={(event) => {
              focusTrayFrom(event.currentTarget);
              props.onAnswer("reject");
            }}
            disabled={disabled}
          >
            No
          </button>
        </>
      }
    >
      <p className="ade-request-note">
        {props.coordinator === undefined ? (
          "El coordinador"
        ) : (
          <span className="ade-nowrap">@{props.coordinator.handle}</span>
        )}{" "}
        lo propone porque: {proposal.reason}
      </p>
      <dl className="ade-proposal-facts">
        <dt>Rol</dt>
        <dd>{proposal.role}</dd>
        <dt>Rutina</dt>
        <dd>{proposal.routine}</dd>
        <dt>Modelo</dt>
        <dd>
          {model === undefined
            ? proposal.modelSelection.model
            : `${model.providerLabel} · ${model.modelName}`}
        </dd>
        <dt>Permisos</dt>
        <dd>{RUNTIME_MODE_TEXT[proposal.runtimeMode]}</dd>
      </dl>
      <details className="ade-proposal-instructions">
        <summary>Instrucciones exactas</summary>
        <pre>{proposal.instructions}</pre>
      </details>
      <p className="ade-request-note">
        Nada se crea sin tu «sí». Un «No» queda en la memoria del proyecto para no repetirlo; la
        rutina la añades tú desde Bots cuando exista.
      </p>
    </NoticeFrame>
  );
}

function HandoffNotice(
  props: NoticeProps & { preview: string; hops: number; onDismiss: () => void },
) {
  const canDismiss = useAtomValue(
    forkBotsDismissHandoffCommand.permissionAtom(props.environmentId),
  );
  return (
    <NoticeFrame
      {...props}
      label="Aviso"
      context="Bots"
      openLabel="Abrir el hilo de origen"
      actions={
        <button
          type="button"
          className="ade-button-quiet"
          onClick={(event) => {
            focusTrayFrom(event.currentTarget);
            props.onDismiss();
          }}
          disabled={canDismiss !== true || props.sending}
        >
          {props.sending ? "Descartando…" : "Descartar"}
        </button>
      }
    >
      <p className="ade-request-note">
        La cadena entre bots llegó a {props.hops} saltos (máximo {FORK_BOTS_HANDOFF_MAX_HOPS}) y no
        se entregó: «{props.preview}». Si hace falta, pásalo tú desde el chat del bot.
      </p>
    </NoticeFrame>
  );
}
