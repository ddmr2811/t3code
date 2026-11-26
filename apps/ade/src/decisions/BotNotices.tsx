import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  FORK_BOTS_HANDOFF_MAX_HOPS,
  type EnvironmentId,
  type ForkBot,
  type ForkBotHandoff,
  type ForkBotProposal,
  type ForkGap,
  type ForkGapInstall,
  type ForkIntegrationRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { Fragment, type ReactNode, useContext, useState } from "react";

import {
  allBotsAtom,
  forkBotsAnswerProposalCommand,
  forkBotsDismissHandoffCommand,
  forkGapsAnswerInstallCommand,
  refreshBots,
} from "../bots/bots.state.ts";
import {
  INTEGRATION_APP_LABELS,
  INTEGRATION_GROUP_LABELS,
  forkIntegrationsAnswerCommand,
  pendingIntegrationRequestsAtom,
  refreshIntegrations,
} from "../bots/integrations.state.ts";
import { RUNTIME_MODE_TEXT, runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { environmentProjects, environmentThreadShells, serverEnvironment } from "../state.ts";
import { focusTrayFrom } from "./Requests.tsx";
import { botQuickAnswer, literalFits, prettyArguments } from "./requests.logic.ts";
import { readWorkflowQuestion } from "@t3tools/client-runtime/workflows";
import {
  type OpenWorkflowQuestion,
  workflowQuestionKey,
  workflowQuestionsAtom,
} from "./workflowQuestions.ts";

export type BotNotice = {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
} & (
  | { readonly type: "handoff"; readonly handoff: ForkBotHandoff; readonly from?: ForkBot }
  | { readonly type: "proposal"; readonly proposal: ForkBotProposal; readonly from?: ForkBot }
  | {
      readonly type: "install";
      readonly gap: ForkGap;
      readonly install: ForkGapInstall;
      readonly from?: ForkBot;
    }
  | {
      readonly type: "integration";
      readonly request: ForkIntegrationRequest;
      readonly from?: ForkBot;
    }
  | { readonly type: "workflow"; readonly open: OpenWorkflowQuestion; readonly from?: ForkBot }
  // An install nobody can see is one nobody can refuse, so a failed read waits here too.
  | { readonly type: "unreadable"; readonly from?: ForkBot }
);

/**
 * What the bots wait on the user for, on every machine, keyed like the decisions panel counts
 * them: installs and outside-app actions a bot asks for, bots a coordinator proposes and handoffs
 * cut for too many hops.
 */
export function useBotNotices(): ReadonlyArray<BotNotice> {
  const { byEnv, handoffsByEnv, proposalsByEnv, gapsByEnv, gapErrors } = useAtomValue(allBotsAtom);
  const pendingRequests = useAtomValue(pendingIntegrationRequestsAtom);
  const { questions } = useAtomValue(workflowQuestionsAtom);
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
  const installs = [...gapsByEnv].flatMap(([environmentId, list]) =>
    list.flatMap((gap) =>
      gap.steps.flatMap((step): BotNotice[] => {
        if (step.install?.answer !== "pending") return [];
        const from = botOf(environmentId, gap.botId);
        return [
          {
            key: `install:${environmentId}:${step.install.id}`,
            type: "install",
            label: "Instalar",
            title: `¿Dejo que @${from?.handle ?? "?"} instale esto?`,
            environmentId,
            gap,
            install: step.install,
            ...(from === undefined ? {} : { from }),
          },
        ];
      }),
    ),
  );
  const unreadable = gapErrors.map((environmentId): BotNotice => ({
    key: `gaps-unreadable:${environmentId}`,
    type: "unreadable",
    label: "Aviso",
    title: "No se pudieron leer las instalaciones que piden los bots",
    environmentId,
  }));
  const integrations = pendingRequests.map(({ environmentId, request }): BotNotice => {
    const from = botOf(environmentId, request.botId);
    return {
      key: `integration:${environmentId}:${request.id}`,
      type: "integration",
      label: INTEGRATION_APP_LABELS[request.app],
      title: `¿Dejo que @${from?.handle ?? "?"} haga ${request.action} en ${INTEGRATION_APP_LABELS[request.app]}?`,
      environmentId,
      request,
      ...(from === undefined ? {} : { from }),
    };
  });
  // A workflow's pause for a person waits here, not in a list of its own.
  const workflows = questions.map((open): BotNotice => ({
    key: workflowQuestionKey(open),
    type: "workflow",
    label: "Flujo",
    title: readWorkflowQuestion(open.question).title,
    environmentId: open.environmentId,
    open,
  }));
  return [...unreadable, ...installs, ...integrations, ...workflows, ...proposals, ...handoffs];
}

// What this ADE is sending for each notice and why the last try failed, shared by the decisions
// panel and Inicio: one click anywhere disables the notice everywhere until the bots refresh.
const botSendingAtom = Atom.make<ReadonlyMap<string, true>>(new Map()).pipe(Atom.keepAlive);
const botErrorsAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(Atom.keepAlive);

/** A «Sí» or «No», or a workflow question's choice with its reason ("" for none). */
type BotAnswer = boolean | { readonly choice: string; readonly reason: string };

const botAnswerRun = (
  registry: AtomRegistry.AtomRegistry,
  notice: BotNotice,
  answer: BotAnswer,
): (() => Promise<string | null>) | null => {
  const { environmentId } = notice;
  if (notice.type === "workflow") {
    if (typeof answer === "boolean") return null;
    const { question } = notice.open;
    return () =>
      runCommand(
        registry,
        serverEnvironment.answerWorkflowQuestion,
        {
          environmentId,
          input: {
            runId: question.runId,
            name: question.name,
            choice: answer.choice,
            ...(answer.reason === "" ? {} : { reason: answer.reason }),
          },
        },
        "No se pudo enviar tu respuesta",
      );
  }
  if (typeof answer !== "boolean") return null;
  const yes = answer;
  switch (notice.type) {
    case "integration":
      return () =>
        runCommand(
          registry,
          forkIntegrationsAnswerCommand,
          { environmentId, input: { id: notice.request.id, answer: yes ? "approve" : "deny" } },
          yes ? "No se pudo ejecutar" : "No se pudo guardar el «No»",
        );
    case "install":
      return () =>
        runCommand(
          registry,
          forkGapsAnswerInstallCommand,
          { environmentId, input: { id: notice.install.id, answer: yes ? "approve" : "reject" } },
          "No se pudo guardar tu respuesta",
        );
    case "proposal":
      return () =>
        runCommand(
          registry,
          forkBotsAnswerProposalCommand,
          { environmentId, input: { id: notice.proposal.id, answer: yes ? "accept" : "reject" } },
          yes ? "No se pudo crear el bot" : "No se pudo guardar el «No»",
        );
    case "handoff":
      return yes
        ? null
        : () =>
            runCommand(
              registry,
              forkBotsDismissHandoffCommand,
              { environmentId, input: { id: notice.handoff.id } },
              "No se pudo descartar el aviso",
            );
    default:
      return null;
  }
};

/** Answers a bot notice once, from the panel or Inicio; a failed answer keeps it, with the reason. */
async function answerBotNotice(
  registry: AtomRegistry.AtomRegistry,
  notice: BotNotice,
  answer: BotAnswer,
) {
  const run = botAnswerRun(registry, notice, answer);
  const { key, environmentId } = notice;
  if (run === null || registry.get(botSendingAtom).has(key)) return;
  registry.update(botSendingAtom, (current) => new Map(current).set(key, true));
  registry.update(botErrorsAtom, (current) => without(current, key));
  const failure = await run();
  if (failure !== null) {
    registry.update(botSendingAtom, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    registry.update(botErrorsAtom, (current) => new Map(current).set(key, failure));
    return;
  }
  refreshBots(registry, environmentId);
  refreshIntegrations(registry, environmentId);
}

const without = (map: ReadonlyMap<string, string>, key: string) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

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
  const sending = useAtomValue(botSendingAtom);
  const errors = useAtomValue(botErrorsAtom);
  const notices = useBotNotices().filter((notice) => props.include(notice.key));
  if (notices.length === 0) return null;
  const error = notices.map((notice) => errors.get(notice.key)).find((e) => e !== undefined);

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
        if (notice.type === "workflow") {
          const { question } = notice.open;
          const thread = question.thread;
          return (
            <WorkflowNotice
              key={key}
              {...common}
              open={notice.open}
              onOpen={
                // A thread on another machine than the run's opens nothing here.
                thread === null ||
                (thread.environmentId !== null && thread.environmentId !== environmentId)
                  ? null
                  : () =>
                      props.onOpenBackLayer(
                        scopedThreadKey(scopeThreadRef(environmentId, thread.threadId as ThreadId)),
                      )
              }
              onAnswer={(choice, reason) =>
                void answerBotNotice(registry, notice, { choice, reason })
              }
            />
          );
        }
        if (notice.type === "integration") {
          return (
            <IntegrationNotice
              key={key}
              {...common}
              request={notice.request}
              onAnswer={(answer) => void answerBotNotice(registry, notice, answer === "approve")}
            />
          );
        }
        if (notice.type === "unreadable") {
          return (
            <NoticeFrame
              key={key}
              {...common}
              label="Aviso"
              context="Bots"
              openLabel=""
              actions={
                <button
                  type="button"
                  className="ade-button-quiet"
                  onClick={() => refreshBots(registry, environmentId)}
                >
                  Reintentar
                </button>
              }
            >
              <p className="ade-request-note">
                Puede haber alguna esperando tu respuesta en esta máquina. Si sigue fallando, el
                archivo de huecos del servidor está dañado o el servidor es anterior a esta función.
              </p>
            </NoticeFrame>
          );
        }
        if (notice.type === "install") {
          const answer = (value: "approve" | "reject") =>
            void answerBotNotice(registry, notice, value === "approve");
          return (
            <InstallNotice
              key={key}
              {...common}
              gap={notice.gap}
              install={notice.install}
              onAnswer={answer}
            />
          );
        }
        if (notice.type === "proposal") {
          const answer = (value: "accept" | "reject") =>
            void answerBotNotice(registry, notice, value === "accept");
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
            onDismiss={() => void answerBotNotice(registry, notice, false)}
          />
        );
      })}
      {error === undefined ? null : (
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

function InstallNotice(
  props: NoticeProps & {
    gap: ForkGap;
    install: ForkGapInstall;
    onAnswer: (answer: "approve" | "reject") => void;
  },
) {
  const canAnswer = useAtomValue(forkGapsAnswerInstallCommand.permissionAtom(props.environmentId));
  const { gap, install } = props;
  const projectTitle = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(props.environmentId),
    (index) => index.get(gap.projectId)?.title ?? null,
  );
  // The server refuses a yes while the bot works: it would wait in a queue, and the thread's
  // permissions could change before it starts.
  const busy = useAtomValue(
    environmentThreadShells.quietThreadShellAtom(scopeThreadRef(props.environmentId, gap.threadId)),
    (thread) => thread?.runtime?.activeRunId != null,
  );
  const disabled = canAnswer !== true || props.sending;
  return (
    <NoticeFrame
      {...props}
      label="Instalar"
      context={projectTitle ?? "Proyecto sin nombre"}
      openLabel="Abrir el hilo del bot"
      actions={
        <>
          <button
            type="button"
            className="ade-button"
            data-agent-confirm
            onClick={(event) => {
              focusTrayFrom(event.currentTarget);
              props.onAnswer("approve");
            }}
            disabled={disabled || busy}
          >
            {props.sending
              ? "Enviando…"
              : busy
                ? "Espera a que el bot termine"
                : "Sí, solo esta vez"}
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
      <dl className="ade-proposal-facts">
        <dt>Le falta</dt>
        <dd>{gap.name}</dd>
        <dt>Qué toca</dt>
        <dd>
          {install.scope === "system"
            ? "El sistema de esta máquina, fuera del proyecto"
            : "Solo el proyecto"}
        </dd>
        <dt>Comando</dt>
        <dd>
          <code className="ade-install-command">{install.command}</code>
        </dd>
        <dt>Vuelta atrás</dt>
        <dd>
          <code className="ade-install-command">{install.rollback}</code>
        </dd>
      </dl>
      <p className="ade-request-note">
        Tu «sí» vale una vez, para este comando, en esta máquina y en el hilo que lo pidió.{" "}
        {install.runtimeMode === "approval-required"
          ? "El bot te pedirá permiso otra vez al ejecutarlo."
          : `El bot lo ejecutará sin volver a preguntar: su hilo va en «${RUNTIME_MODE_TEXT[install.runtimeMode]}».`}{" "}
        No subas el modo del hilo hasta que el bot termine.
      </p>
    </NoticeFrame>
  );
}

/** The arguments are the bot's data: shown exactly as they will run, never rendered as markup. */
function IntegrationNotice(
  props: NoticeProps & {
    request: ForkIntegrationRequest;
    onAnswer: (answer: "approve" | "deny") => void;
  },
) {
  const canAnswer = useAtomValue(forkIntegrationsAnswerCommand.permissionAtom(props.environmentId));
  const { request } = props;
  const disabled = canAnswer !== true || props.sending;
  return (
    <NoticeFrame
      {...props}
      label={INTEGRATION_APP_LABELS[request.app]}
      context="Integraciones"
      openLabel="Abrir el hilo del bot"
      actions={
        <>
          <button
            type="button"
            className="ade-button"
            data-agent-confirm
            onClick={(event) => {
              focusTrayFrom(event.currentTarget);
              props.onAnswer("approve");
            }}
            disabled={disabled}
          >
            {props.sending ? "Enviando…" : "Sí, una vez"}
          </button>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={(event) => {
              focusTrayFrom(event.currentTarget);
              props.onAnswer("deny");
            }}
            disabled={disabled}
          >
            No
          </button>
        </>
      }
    >
      <dl className="ade-proposal-facts">
        <dt>Acción</dt>
        <dd>{request.action}</dd>
        <dt>Permiso</dt>
        <dd>{INTEGRATION_GROUP_LABELS[request.group] ?? request.group}</dd>
      </dl>
      <div className="ade-proposal-instructions">
        <p className="ade-request-note">Argumentos exactos</p>
        <pre>{prettyArguments(request.arguments)}</pre>
      </div>
      <p className="ade-request-note">
        El «sí» vale una sola vez y para estos argumentos: la llamada la hace el servidor, no el
        bot. Un «No» es definitivo y el bot no puede repetir esta misma petición en 24 horas.
      </p>
    </NoticeFrame>
  );
}

/**
 * A run's question, answered with one of its choices. Every choice is the user's decision, so
 * none is pressed by an agent without confirmation. Arguments an integration step will use are
 * shown exactly, never rendered as markup.
 */
function WorkflowNotice(
  props: NoticeProps & {
    open: OpenWorkflowQuestion;
    onAnswer: (choice: string, reason: string) => void;
  },
) {
  const canAnswer = useAtomValue(
    serverEnvironment.answerWorkflowQuestion.permissionAtom(props.environmentId),
  );
  const [reason, setReason] = useState("");
  const view = readWorkflowQuestion(props.open.question);
  const disabled = canAnswer !== true || props.sending;
  const needsReason = view.choices.some((choice) => choice.requireReason);
  return (
    <NoticeFrame
      {...props}
      label="Flujo"
      context={props.open.workflow ?? "Workflows"}
      openLabel="Abrir el hilo del flujo"
      actions={
        <>
          {view.choices.map((choice, index) => (
            <button
              key={choice.value}
              type="button"
              className={index === 0 ? "ade-button" : "ade-button-quiet"}
              data-agent-confirm
              onClick={(event) => {
                focusTrayFrom(event.currentTarget);
                props.onAnswer(choice.value, reason.trim());
              }}
              disabled={disabled || (choice.requireReason && reason.trim() === "")}
            >
              {props.sending && index === 0 ? "Enviando…" : choice.value}
            </button>
          ))}
        </>
      }
    >
      {view.body === null ? null : <p className="ade-request-note">{view.body}</p>}
      {view.arguments === null ? null : (
        <div className="ade-proposal-instructions">
          <p className="ade-request-note">Argumentos exactos</p>
          <pre>{view.arguments}</pre>
        </div>
      )}
      {view.choices.some((choice) => choice.description !== null) ? (
        <dl className="ade-proposal-facts">
          {view.choices
            .filter((choice) => choice.description !== null)
            .map((choice) => (
              <Fragment key={choice.value}>
                <dt>{choice.value}</dt>
                <dd>{choice.description}</dd>
              </Fragment>
            ))}
        </dl>
      ) : null}
      {view.links.map((link) => (
        <a
          key={link.url}
          className="ade-request-note"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          {link.label}
        </a>
      ))}
      {needsReason ? (
        <label className="ade-request-note grid gap-1">
          Motivo (algunas respuestas lo piden)
          <input
            className="box-border w-full min-w-0 rounded-sm border border-border bg-background px-2.5 py-2 text-[13px] text-foreground max-[720px]:min-h-11"
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p className="ade-request-note">
        El flujo está en pausa hasta que respondas; tu respuesta lo reanuda.
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

const NO_THREAD = Atom.make<{
  readonly runtime?: { readonly activeRunId?: unknown } | null;
} | null>(null);

/** A command, arguments or instructions as they will run: plain text, never markup. */
function Literal(props: { label: string; text: string; open: boolean; onOpen: () => void }) {
  const clipped = !props.open && !literalFits(props.text);
  return (
    <div className="ade-foryou-literal">
      <p className="ade-foryou-note">{props.label}</p>
      <pre className="ade-foryou-literal-text" data-clipped={clipped || undefined}>
        {props.text}
      </pre>
      {clipped ? (
        <button type="button" className="ade-button-quiet" onClick={props.onOpen}>
          Ver todo
        </button>
      ) : null}
    </div>
  );
}

/**
 * Inicio's card body for a bot notice: its «Sí»/«No», or a workflow question's choices, beside the
 * exact text they rest on, sent as the panel sends them. Never an answer while that text hides.
 */
export function QuickBotNotice(props: { notice: BotNotice; onOpen: () => void }) {
  const { notice } = props;
  const { environmentId } = notice;
  const registry = useContext(RegistryContext);
  const sending = useAtomValue(botSendingAtom, (sent) => sent.has(notice.key));
  const error = useAtomValue(botErrorsAtom, (errors) => errors.get(notice.key) ?? null);
  const permissions = {
    install: useAtomValue(forkGapsAnswerInstallCommand.permissionAtom(environmentId)),
    integration: useAtomValue(forkIntegrationsAnswerCommand.permissionAtom(environmentId)),
    proposal: useAtomValue(forkBotsAnswerProposalCommand.permissionAtom(environmentId)),
    workflow: useAtomValue(serverEnvironment.answerWorkflowQuestion.permissionAtom(environmentId)),
  };
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  // The server refuses an install's yes while its bot works, as the panel says.
  const busy = useAtomValue(
    notice.type === "install"
      ? environmentThreadShells.quietThreadShellAtom(
          scopeThreadRef(environmentId, notice.gap.threadId),
        )
      : NO_THREAD,
    (thread) => thread?.runtime?.activeRunId != null,
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // The answer a first click armed, when it asks twice.
  const [armed, setArmed] = useState<string | null>(null);
  const view = notice.type === "workflow" ? readWorkflowQuestion(notice.open.question) : null;
  const quick =
    notice.type === "workflow"
      ? botQuickAnswer({ type: "workflow", view: view! })
      : botQuickAnswer(notice);

  const open = (
    <button type="button" className="ade-button-quiet ade-foryou-open" onClick={props.onOpen}>
      Abrir
      <ArrowRightIcon size={13} weight="bold" aria-hidden />
    </button>
  );
  if (quick.kind === "open" || notice.type === "handoff" || notice.type === "unreadable") {
    return (
      <>
        <p className="ade-foryou-what">{notice.title}</p>
        <div className="ade-foryou-actions">{open}</div>
      </>
    );
  }

  const facts: ReadonlyArray<readonly [string, string]> =
    notice.type === "workflow"
      ? (view?.choices ?? []).flatMap((choice) =>
          choice.description === null ? [] : [[choice.value, choice.description] as const],
        )
      : notice.type === "install"
        ? [
            ["Le falta", notice.gap.name],
            [
              "Qué toca",
              notice.install.scope === "system"
                ? "El sistema de esta máquina, fuera del proyecto"
                : "Solo el proyecto",
            ],
          ]
        : notice.type === "integration"
          ? [
              ["Acción", notice.request.action],
              ["Permiso", INTEGRATION_GROUP_LABELS[notice.request.group] ?? notice.request.group],
            ]
          : [
              ["Rol", notice.proposal.role],
              ["Rutina", notice.proposal.routine],
              [
                "Modelo",
                (() => {
                  const { instanceId, model } = notice.proposal.modelSelection;
                  const option = availableMachineModelOptions(config).find(
                    (candidate) => candidate.instanceId === instanceId && candidate.model === model,
                  );
                  return option === undefined
                    ? model
                    : `${option.providerLabel} · ${option.modelName}`;
                })(),
              ],
              ["Permisos", RUNTIME_MODE_TEXT[notice.proposal.runtimeMode]],
            ];
  const allShown = quick.literals.every(
    (literal) => opened.has(literal.label) || literalFits(literal.text),
  );
  const disabled = permissions[notice.type] !== true || sending || !allShown;
  const choose = (armedAs: string, answer: BotAnswer) => {
    if (!allShown) return;
    if (quick.confirm && armed !== armedAs) return setArmed(armedAs);
    void answerBotNotice(registry, notice, answer);
  };

  return (
    <>
      <p className="ade-foryou-what">{notice.title}</p>
      {view?.body == null ? null : <p className="ade-foryou-note">{view.body}</p>}
      {facts.length === 0 ? null : (
        <dl className="ade-proposal-facts">
          {facts.map(([term, value]) => (
            <Fragment key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {quick.literals.map((literal) => (
        <Literal
          key={literal.label}
          label={literal.label}
          text={literal.text}
          open={opened.has(literal.label)}
          onOpen={() => setOpened((current) => new Set(current).add(literal.label))}
        />
      ))}
      {notice.type === "install" ? (
        <p className="ade-foryou-note">
          {notice.install.runtimeMode === "approval-required"
            ? "Vale una vez. El bot te pedirá permiso otra vez al ejecutarlo."
            : `Vale una vez. El bot lo ejecutará sin volver a preguntar: su hilo va en «${RUNTIME_MODE_TEXT[notice.install.runtimeMode]}».`}
        </p>
      ) : null}
      {allShown ? null : <p className="ade-foryou-note">Abre «Ver todo» para poder contestar.</p>}
      {armed !== null && !sending ? (
        <p className="ade-foryou-note" role="status">
          No se puede deshacer desde aquí: pulsa otra vez para confirmar.
        </p>
      ) : null}
      <div className="ade-foryou-actions">
        {quick.kind === "choices" ? (
          quick.choices.map((choice, index) => (
            <button
              key={choice}
              type="button"
              className={index === 0 ? "ade-button" : "ade-button-quiet"}
              disabled={disabled}
              onClick={() => choose(choice, { choice, reason: "" })}
            >
              {sending ? "Enviando…" : armed === choice ? `Confirmar «${choice}»` : choice}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="ade-button"
              disabled={disabled || busy}
              onClick={() => choose("sí", true)}
            >
              {sending
                ? "Enviando…"
                : busy
                  ? "Espera a que el bot termine"
                  : armed === "sí"
                    ? "Confirmar sí"
                    : "Sí"}
            </button>
            <button
              type="button"
              className="ade-button-quiet"
              disabled={permissions[notice.type] !== true || sending}
              onClick={() => void answerBotNotice(registry, notice, false)}
            >
              No
            </button>
          </>
        )}
        {open}
      </div>
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
