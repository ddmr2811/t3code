import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  MessageId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useContext, useMemo, useRef, useState } from "react";

import {
  environmentThreadDetails,
  operateAccessAtom,
  serverEnvironment,
  threadEnvironment,
} from "../state.ts";
import {
  type ProviderChoice,
  providerChoices,
  type TurnDraft,
  turnSettings,
} from "./composer.logic.ts";

const RUNTIME_MODE_TEXT: Record<RuntimeMode, string> = {
  "approval-required": "Pedir aprobación",
  "auto-accept-edits": "Aceptar ediciones",
  auto: "Automático",
  "full-access": "Acceso total",
};
const INTERACTION_MODE_TEXT: Record<ProviderInteractionMode, string> = {
  default: "Normal",
  plan: "Plan",
};

// Kept for the session, so a draft survives moving to another thread and back.
export const draftAtom = Atom.family((_threadKey: string) =>
  Atom.make<TurnDraft>({ text: "" }).pipe(Atom.keepAlive),
);

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const NO_PROVIDERS: ReadonlyArray<ProviderChoice> = [];

/** Runs one thread command; the failure comes back as Spanish text, never thrown. */
export async function runCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  registry: Parameters<typeof runAtomCommand>[0],
  command: AtomCommand<W, A, E>,
  input: W,
  failure: string,
): Promise<string | null> {
  const result = await runAtomCommand(registry, command, input, { reportFailure: false });
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  const detail = isAuthorizationError(error)
    ? `la máquina pide el permiso ${error.requiredScope}, que esta sesión no tiene`
    : errorDisplayMessage(error);
  return detail === null ? `${failure}.` : `${failure}: ${detail}`;
}

interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** A labelled menu of radio choices; choosing one closes it. */
function Picker<T extends string>(props: {
  label: string;
  current: string;
  groups: ReadonlyArray<{ readonly label?: string; readonly choices: ReadonlyArray<Choice<T>> }>;
  selected: T;
  onSelect: (value: T) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (menu.current !== null) menu.current.open = false;
  };
  return (
    <details
      ref={menu}
      className="ade-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.open) {
          close();
          menu.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        <span className="ade-sr-only">{props.label}: </span>
        {props.current}
      </summary>
      <div className="ade-picker-menu">
        {props.groups.map((group, index) => (
          <fieldset key={group.label ?? index}>
            <legend className={group.label === undefined ? "ade-sr-only" : undefined}>
              {group.label ?? props.label}
            </legend>
            {group.choices.map((choice) => (
              <label key={choice.value}>
                <input
                  type="radio"
                  name={props.label}
                  checked={choice.value === props.selected}
                  onChange={() => {
                    props.onSelect(choice.value);
                    close();
                  }}
                  // Choosing the current value changes nothing, but still closes the menu.
                  onClick={choice.value === props.selected ? close : undefined}
                />
                {choice.label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </details>
  );
}

const modelKey = (instanceId: string, slug: string) => JSON.stringify([instanceId, slug]);

function SettingsPickers(props: {
  thread: EnvironmentThreadShell;
  providers: ReadonlyArray<ProviderChoice>;
  draft: TurnDraft;
  setDraft: (update: (draft: TurnDraft) => TurnDraft) => void;
}) {
  const { thread, providers } = props;
  const settings = turnSettings(
    props.draft,
    {
      model: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    },
    providers,
  );
  const provider = providers.find((choice) => choice.instanceId === settings.model.instanceId);
  const modelName = provider?.models.find((model) => model.slug === settings.model.model)?.name;
  return (
    <div className="ade-composer-settings">
      <Picker
        label="Modelo"
        current={
          modelName === undefined
            ? `${settings.model.model} (no disponible)`
            : `${provider!.label} · ${modelName}`
        }
        groups={providers.map((choice) => ({
          label: choice.label,
          choices: choice.models.map((model) => ({
            value: modelKey(choice.instanceId, model.slug),
            label: model.name,
          })),
        }))}
        selected={modelKey(settings.model.instanceId, settings.model.model)}
        onSelect={(value) => {
          const [instanceId, slug] = JSON.parse(value) as [string, string];
          const chosen = providers.find((choice) => choice.instanceId === instanceId);
          if (chosen === undefined) return;
          const own = thread.modelSelection;
          props.setDraft((draft) => ({
            ...draft,
            // The thread's own model keeps its options, such as reasoning effort.
            model:
              own.instanceId === instanceId && own.model === slug
                ? own
                : { instanceId: chosen.instanceId, model: slug },
          }));
        }}
      />
      <Picker
        label="Modo"
        current={RUNTIME_MODE_TEXT[settings.runtimeMode]}
        groups={[
          {
            choices: (provider?.runtimeModes ?? [settings.runtimeMode]).map((mode) => ({
              value: mode,
              label: RUNTIME_MODE_TEXT[mode],
            })),
          },
        ]}
        selected={settings.runtimeMode}
        onSelect={(runtimeMode) => props.setDraft((draft) => ({ ...draft, runtimeMode }))}
      />
      {provider?.interactionModes === true ? (
        <Picker
          label="Interacción"
          current={INTERACTION_MODE_TEXT[settings.interactionMode]}
          groups={[
            {
              choices: (["default", "plan"] as const).map((mode) => ({
                value: mode,
                label: INTERACTION_MODE_TEXT[mode],
              })),
            },
          ]}
          selected={settings.interactionMode}
          onSelect={(interactionMode) => props.setDraft((draft) => ({ ...draft, interactionMode }))}
        />
      ) : null}
    </div>
  );
}

function QueuedRun(props: { threadRef: ScopedThreadRef; runId: RunId; text: string }) {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<{ removing: boolean; error: string | null }>({
    removing: false,
    error: null,
  });
  const remove = async () => {
    setState({ removing: true, error: null });
    const error = await runCommand(
      registry,
      threadEnvironment.cancelQueuedRun,
      {
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, runId: props.runId },
      },
      "No se pudo retirar de la cola",
    );
    // On success the row leaves with the server's queue; until then it says what it is doing.
    if (error !== null) setState({ removing: false, error });
  };
  return (
    <li className="ade-queued">
      <span className="ade-queued-tag">En cola</span>
      <span className="ade-queued-text">{props.text}</span>
      <button
        type="button"
        className="ade-button-quiet"
        disabled={state.removing}
        onClick={() => void remove()}
      >
        {state.removing ? "Retirando…" : "Retirar"}
      </button>
      {state.error === null ? null : (
        <p className="ade-error" role="alert">
          {state.error}
        </p>
      )}
    </li>
  );
}

function QueuedRuns(props: { threadRef: ScopedThreadRef }) {
  const queued = useAtomValue(
    environmentThreadDetails.queueWorkflowAtom(props.threadRef),
  )?.queuedRuns;
  if (queued === undefined || queued.length === 0) return null;
  return (
    <ul className="ade-queue" aria-label="Mensajes en cola">
      {queued.map(({ run, text }) => (
        <QueuedRun key={run.id} threadRef={props.threadRef} runId={run.id} text={text} />
      ))}
    </ul>
  );
}

function StopButton(props: { threadRef: ScopedThreadRef; onError: (error: string) => void }) {
  const registry = useContext(RegistryContext);
  const stop = useAtomValue(environmentThreadDetails.runStopAtom(props.threadRef));
  const [asking, setAsking] = useState(false);
  const stopping = asking || stop?.state === "stopping";
  const interrupt = async () => {
    setAsking(true);
    const error = await runCommand(
      registry,
      threadEnvironment.interruptTurn,
      {
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId },
      },
      "No se pudo parar el turno",
    );
    setAsking(false);
    if (error !== null) props.onError(error);
  };
  return (
    <button
      type="button"
      className="ade-button-quiet"
      disabled={stopping}
      onClick={() => void interrupt()}
    >
      {stopping ? "Parando…" : stop?.state === "unresponsive" ? "Parar otra vez" : "Parar"}
    </button>
  );
}

function ComposerForm(props: {
  threadRef: ScopedThreadRef;
  thread: EnvironmentThreadShell;
  readOnlyReason: string | null;
}) {
  const { threadRef, thread } = props;
  const registry = useContext(RegistryContext);
  const [draft, setDraft] = useAtom(draftAtom(scopedThreadKey(threadRef)));
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const providers = useMemo(
    () => (config === null ? NO_PROVIDERS : providerChoices(config, thread.projectId)),
    [config, thread.projectId],
  );
  const running =
    useAtomValue(environmentThreadDetails.queueWorkflowAtom(threadRef))?.activeRun != null;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = draft.text;
    if (sending || text.trim() === "") return;
    const settings = turnSettings(
      draft,
      {
        model: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
      providers,
    );
    const target = { environmentId: threadRef.environmentId };
    const threadId = threadRef.threadId;
    setSending(true);
    setError(null);
    // The thread keeps its modes between turns, so a changed one is set before the message.
    const failure =
      (settings.runtimeMode === thread.runtimeMode
        ? null
        : await runCommand(
            registry,
            threadEnvironment.setRuntimeMode,
            { ...target, input: { threadId, runtimeMode: settings.runtimeMode } },
            "No se pudo cambiar el modo",
          )) ??
      (settings.interactionMode === thread.interactionMode
        ? null
        : await runCommand(
            registry,
            threadEnvironment.setInteractionMode,
            { ...target, input: { threadId, interactionMode: settings.interactionMode } },
            "No se pudo cambiar la interacción",
          )) ??
      (await runCommand(
        registry,
        threadEnvironment.startTurn,
        {
          ...target,
          input: {
            threadId,
            message: {
              messageId: MessageId.make(SecureRandom.uuidV4Unsafe()),
              role: "user",
              text,
              attachments: [],
            },
            modelSelection: settings.model,
            runtimeMode: settings.runtimeMode,
            interactionMode: settings.interactionMode,
            // While the agent works, the message waits its turn in the server's queue.
            dispatchMode: resolveComposerDispatchMode({
              running,
              alternateModifier: false,
              activeTurnDefault: "queue",
            }),
          },
        },
        "No se pudo enviar el mensaje",
      ));
    setSending(false);
    setError(failure);
    // Text typed while the message was on its way stays.
    if (failure === null)
      setDraft((current) => (current.text === text ? { ...current, text: "" } : current));
  };

  return (
    <form
      className="ade-composer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {/* Disabled as a whole on a read-only machine; the server refuses the commands anyway. */}
      <fieldset disabled={props.readOnlyReason !== null}>
        <legend className="ade-sr-only">Nuevo mensaje</legend>
        <textarea
          className="ade-composer-text"
          aria-label="Mensaje"
          placeholder={
            running ? "Escribe; se enviará cuando termine este turno" : "Escribe un mensaje"
          }
          rows={3}
          value={draft.text}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft((current) => ({ ...current, text }));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="ade-composer-bar">
          <SettingsPickers
            thread={thread}
            providers={providers}
            draft={draft}
            setDraft={setDraft}
          />
          <div className="ade-composer-actions">
            {running ? <StopButton threadRef={threadRef} onError={setError} /> : null}
            <button
              type="submit"
              className="ade-button"
              disabled={sending || draft.text.trim() === ""}
            >
              {sending ? "Enviando…" : running ? "Poner en cola" : "Enviar"}
            </button>
          </div>
        </div>
      </fieldset>
      {props.readOnlyReason === null ? null : (
        <p className="ade-composer-note" role="status">
          {props.readOnlyReason}
        </p>
      )}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const READ_ONLY_TEXT = {
  read: "Solo lectura: la sesión de este ADE en esta máquina no tiene permiso para operar (orchestration:operate). Vuelve a emparejarla con un enlace que lo conceda.",
  unknown: "No se pudo comprobar el permiso de esta máquina. Se vuelve a intentar al reconectar.",
  loading: "Comprobando el permiso de esta máquina…",
};

/** The selected thread's composer, with its queue above it. */
export function Composer(props: { threadRef: ScopedThreadRef; thread: EnvironmentThreadShell }) {
  const access = useAtomValue(operateAccessAtom(props.threadRef.environmentId));
  return (
    <section className="ade-composer" aria-label="Compositor">
      <QueuedRuns threadRef={props.threadRef} />
      <ComposerForm
        threadRef={props.threadRef}
        thread={props.thread}
        readOnlyReason={access === "operate" ? null : READ_ONLY_TEXT[access ?? "loading"]}
      />
    </section>
  );
}
