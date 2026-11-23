import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  type PendingThreadRequests,
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  ProviderApprovalDecision,
  ProviderRequestKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { draftAtom, runCommand } from "../composer/Composer.tsx";
import {
  environmentThreadDetails,
  environmentThreadShells,
  operateAccessAtom,
  threadEnvironment,
} from "../state.ts";
import {
  type AnswerDrafts,
  type ApprovalChoice,
  approvalChoices,
  approvalFile,
  orphanedAnswerTexts,
} from "./requests.logic.ts";

const KIND_TEXT: Record<ProviderRequestKind, string> = {
  command: "Ejecutar un comando",
  "file-read": "Leer ficheros",
  "file-change": "Editar ficheros",
  "mcp-elicitation": "Petición de un servidor MCP",
  permission: "Permiso",
};

const FULL_ACCESS_TEXT = {
  ask_rule:
    "El hilo tiene acceso total, pero una regla «preguntar» de la configuración del agente coincide con esta acción.",
  provider_check:
    "El hilo tiene acceso total, pero el agente se para en algunas comprobaciones propias que ningún ajuste salta. Revisa la petición antes de aprobarla.",
};

const NOT_ANSWERABLE = "El proceso del agente ya no está: para o reinicia el hilo para responder.";

// Shared by the thread and the decisions panel, and kept for the session: what is typed for a
// question survives moving between them, and outlives the question if it is answered elsewhere.
const answerDraftsAtom = Atom.make<AnswerDrafts>({}).pipe(Atom.keepAlive);
// Questions this ADE is sending an answer for; their drafts are not "answered elsewhere".
const answeringAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

const NO_REQUESTS = Atom.make<PendingThreadRequests | null>(null);

function useCanAnswer(threadRef: ScopedThreadRef) {
  return useAtomValue(operateAccessAtom(threadRef.environmentId)) === "operate";
}

function ApprovalCard(props: { threadRef: ScopedThreadRef; approval: ThreadPendingApproval }) {
  const { threadRef, approval } = props;
  const registry = useContext(RegistryContext);
  const canAnswer = useCanAnswer(threadRef) && approval.responseCapability === "live";
  // The decision on its way, or already accepted by the server: the card leaves with the request.
  const [sent, setSent] = useState<ProviderApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = approvalChoices(approval.options);
  // As JSON so streaming that changes nothing here re-renders nothing.
  const fileJson = useAtomValue(environmentThreadDetails.stateAtom(threadRef), (state) =>
    JSON.stringify(approvalFile(Option.getOrNull(state.data)?.turnItems ?? [], approval.requestId)),
  );
  const file = JSON.parse(fileJson) as ReturnType<typeof approvalFile>;
  const respond = async (decision: ProviderApprovalDecision) => {
    setSent(decision);
    setError(null);
    const failure = await runCommand(
      registry,
      threadEnvironment.respondToApproval,
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId: approval.requestId, decision },
      },
      "No se pudo responder a la aprobación",
    );
    if (failure === null) return;
    setSent(null);
    setError(failure);
  };
  const button = (choice: ApprovalChoice) => (
    <button
      key={choice.decision}
      type="button"
      className={choice.decision === "accept" ? "ade-button" : "ade-button-quiet"}
      disabled={sent !== null}
      onClick={() => void respond(choice.decision)}
    >
      {sent === choice.decision ? "Enviando…" : choice.label}
    </button>
  );
  const broad = choices.filter((choice) => choice.broad);
  return (
    <article className="ade-request" aria-label={`Aprobación: ${KIND_TEXT[approval.requestKind]}`}>
      <p className="ade-request-tag">Aprobación · {KIND_TEXT[approval.requestKind]}</p>
      {/* The whole command or path, never cut: it scrolls instead. */}
      <pre className="ade-request-detail">{approval.detail || approval.requestKind}</pre>
      {file === null ? null : (
        <>
          <p className="ade-request-note">Fichero:</p>
          <pre className="ade-request-detail">{file.path}</pre>
          {file.diff === undefined ? null : (
            <details>
              <summary className="ade-request-note">Ver los cambios</summary>
              <pre className="ade-request-detail">{file.diff}</pre>
            </details>
          )}
        </>
      )}
      {approval.appName ? <p className="ade-request-note">{approval.appName}</p> : null}
      {approval.reason ? <p className="ade-request-note">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="ade-request-note">{FULL_ACCESS_TEXT[approval.fullAccessOverride]}</p>
      ) : null}
      {approval.responseCapability === "live" ? null : (
        <p className="ade-request-note" role="status">
          {NOT_ANSWERABLE}
        </p>
      )}
      {/* Disabled as a whole where this session cannot answer; the server refuses it anyway. */}
      <fieldset disabled={!canAnswer}>
        <div className="ade-request-actions">
          {choices.filter((choice) => !choice.broad).map(button)}
        </div>
        {broad.length === 0 ? null : (
          <div className="ade-request-broad">
            <p className="ade-request-note">
              Más que esta petición. El alcance lo fija el proveedor y puede durar más que este
              hilo:
            </p>
            <div className="ade-request-actions">{broad.map(button)}</div>
            {broad.map((choice) =>
              choice.warning === undefined ? null : (
                <p key={choice.decision} className="ade-request-note">
                  {choice.label}: {choice.warning}
                </p>
              ),
            )}
          </div>
        )}
      </fieldset>
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

function QuestionCard(props: { threadRef: ScopedThreadRef; prompt: ThreadPendingUserInput }) {
  const { threadRef, prompt } = props;
  const registry = useContext(RegistryContext);
  const canAnswer = useCanAnswer(threadRef) && prompt.responseCapability !== "not_resumable";
  const requestKey = userInputDraftKey(
    threadRef.environmentId,
    threadRef.threadId,
    prompt.requestId,
  );
  const edits = useAtomValue(answerDraftsAtom, (drafts) => drafts[requestKey]);
  const answers = seedUserInputDraftAnswers(prompt.questions, edits ?? {});
  const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
  const [sent, setSent] = useState<"answer" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edit = (questionId: string, next: (typeof answers)[string]) =>
    registry.update(answerDraftsAtom, (drafts) => ({
      ...drafts,
      [requestKey]: { ...drafts[requestKey], [questionId]: next },
    }));
  const setAnswering = (on: boolean) =>
    registry.update(answeringAtom, (current) => {
      const next = new Set(current);
      if (on) next.add(requestKey);
      else next.delete(requestKey);
      return next;
    });
  const run = async (kind: "answer" | "dismiss", send: () => Promise<string | null>) => {
    setSent(kind);
    setError(null);
    setAnswering(true);
    const failure = await send();
    if (failure === null) {
      registry.update(answerDraftsAtom, ({ [requestKey]: _sent, ...rest }) => rest);
    } else {
      setSent(null);
      setError(failure);
    }
    setAnswering(false);
  };
  const target = { environmentId: threadRef.environmentId };
  const request = { threadId: threadRef.threadId, requestId: prompt.requestId };
  return (
    <form
      className="ade-request"
      aria-label="Pregunta del agente"
      onSubmit={(event) => {
        event.preventDefault();
        if (resolved === null || sent !== null) return;
        void run("answer", () =>
          runCommand(
            registry,
            threadEnvironment.respondToUserInput,
            { ...target, input: { ...request, answers: resolved } },
            "No se pudo enviar la respuesta",
          ),
        );
      }}
    >
      <p className="ade-request-tag">Pregunta</p>
      <fieldset disabled={!canAnswer || sent !== null}>
        {prompt.questions.map((question) => {
          const draft = answers[question.id];
          return (
            <div key={question.id} className="ade-question">
              <p className="ade-question-header">{question.header}</p>
              <p className="ade-question-text">{question.question}</p>
              {question.options.length === 0 ? null : (
                <div className="ade-question-options">
                  {question.options.map((option) => {
                    const value = option.value ?? option.label;
                    return (
                      <button
                        key={value}
                        type="button"
                        className="ade-option"
                        aria-pressed={isPendingUserInputOptionSelected(question, draft, value)}
                        onClick={() =>
                          edit(
                            question.id,
                            togglePendingUserInputOptionSelection(question, draft, value),
                          )
                        }
                      >
                        <span>{option.label}</span>
                        {option.description === option.label ? null : (
                          <span className="ade-option-description">{option.description}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {question.multiSelect ? (
                <p className="ade-request-note">Puedes marcar varias.</p>
              ) : null}
              {question.allowCustomAnswer === false ? null : (
                <textarea
                  className="ade-question-custom"
                  aria-label={
                    question.options.length === 0
                      ? question.question
                      : `Otra respuesta: ${question.question}`
                  }
                  placeholder={
                    question.options.length === 0 ? "Escribe tu respuesta" : "O escribe otra"
                  }
                  rows={2}
                  value={draft?.customAnswer ?? ""}
                  onChange={(event) =>
                    edit(
                      question.id,
                      setPendingUserInputCustomAnswer(question, draft, event.currentTarget.value),
                    )
                  }
                />
              )}
            </div>
          );
        })}
      </fieldset>
      {prompt.responseCapability === "not_resumable" ? (
        <p className="ade-request-note" role="status">
          {NOT_ANSWERABLE}
        </p>
      ) : null}
      <div className="ade-request-actions">
        <button
          type="submit"
          className="ade-button"
          disabled={!canAnswer || sent !== null || resolved === null}
        >
          {sent === "answer" ? "Enviando…" : "Enviar respuesta"}
        </button>
        {prompt.dismissible ? (
          <button
            type="button"
            className="ade-button-quiet"
            disabled={!canAnswer || sent !== null}
            onClick={() =>
              void run("dismiss", () =>
                runCommand(
                  registry,
                  threadEnvironment.dismissUserInput,
                  { ...target, input: request },
                  "No se pudo descartar la pregunta",
                ),
              )
            }
          >
            {sent === "dismiss" ? "Descartando…" : "Descartar la pregunta"}
          </button>
        ) : null}
      </div>
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** What was typed for a question that was then answered somewhere else: shown, never dropped. */
function OrphanedAnswers(props: { threadRef: ScopedThreadRef; requests: PendingThreadRequests }) {
  const { environmentId, threadId } = props.threadRef;
  const registry = useContext(RegistryContext);
  const drafts = useAtomValue(answerDraftsAtom);
  const answering = useAtomValue(answeringAtom);
  const orphans = orphanedAnswerTexts(
    drafts,
    environmentId,
    threadId,
    props.requests.userInputs.map((prompt) => prompt.requestId),
    (requestKey) => answering.has(requestKey),
  );
  const forget = (requestKey: string) =>
    registry.update(answerDraftsAtom, ({ [requestKey]: _gone, ...rest }) => rest);
  return orphans.map(({ requestKey, text }) => (
    <article key={requestKey} className="ade-request" aria-label="Respuesta sin enviar">
      <p className="ade-request-tag">Respuesta sin enviar</p>
      <p className="ade-request-note">
        La pregunta se resolvió en otro sitio antes de que enviaras esto:
      </p>
      <pre className="ade-request-detail">{text}</pre>
      <div className="ade-request-actions">
        <button
          type="button"
          className="ade-button-quiet"
          onClick={() => {
            registry.update(draftAtom(scopedThreadKey(props.threadRef)), (draft) => ({
              ...draft,
              text: draft.text.trim() === "" ? text : `${draft.text}\n${text}`,
            }));
            forget(requestKey);
          }}
        >
          Pasar al mensaje
        </button>
        <button type="button" className="ade-button-quiet" onClick={() => forget(requestKey)}>
          Descartar
        </button>
      </div>
    </article>
  ));
}

/**
 * One thread's pending approvals and questions, each answerable in place. `whole` also shows what
 * the thread view owns: unsent answers, and the note for a session that cannot answer.
 */
export function RequestCards(props: {
  threadRef: ScopedThreadRef;
  subscribe: boolean;
  whole?: boolean;
}) {
  // Without a pending request there is nothing worth a detail subscription.
  const requests = useAtomValue(
    props.subscribe ? environmentThreadDetails.pendingRequestsAtom(props.threadRef) : NO_REQUESTS,
  );
  const access = useAtomValue(operateAccessAtom(props.threadRef.environmentId));
  if (requests === null) return null;
  const count = requests.approvals.length + requests.userInputs.length;
  return (
    <>
      {props.whole === true && count > 0 && access !== "operate" && access !== null ? (
        <p className="ade-request-note" role="status">
          Solo lectura: esta sesión no puede contestar en esta máquina.
        </p>
      ) : null}
      {requests.approvals.map((approval) => (
        <ApprovalCard key={approval.requestId} threadRef={props.threadRef} approval={approval} />
      ))}
      {requests.userInputs.map((prompt) => (
        <QuestionCard key={prompt.requestId} threadRef={props.threadRef} prompt={prompt} />
      ))}
      {props.whole === true ? (
        <OrphanedAnswers threadRef={props.threadRef} requests={requests} />
      ) : null}
    </>
  );
}

/** Above the composer: what the selected thread and its subagents wait on. */
export function ThreadRequests(props: {
  threadRef: ScopedThreadRef;
  onOpenThread: (key: string) => void;
}) {
  const children = useAtomValue(environmentThreadShells.childThreadInputsAtom(props.threadRef));
  return (
    <section className="ade-requests" aria-label="Peticiones pendientes">
      <RequestCards threadRef={props.threadRef} subscribe whole />
      {children.map((child) => {
        const childRef = { environmentId: child.environmentId, threadId: child.id };
        const key = scopedThreadKey(childRef);
        return (
          <div key={key} className="ade-request-child">
            <p className="ade-request-note">
              Del subagente «{child.title}» ·{" "}
              <button type="button" className="ade-link" onClick={() => props.onOpenThread(key)}>
                Abrir su hilo
              </button>
            </p>
            <RequestCards
              threadRef={childRef}
              subscribe={child.hasPendingApprovals || child.hasPendingUserInput}
            />
          </div>
        );
      })}
    </section>
  );
}
