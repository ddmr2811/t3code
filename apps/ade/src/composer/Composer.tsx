import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { selectableProviderOptionChoices } from "@t3tools/client-runtime/model-traits";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type ChatImageAttachment,
  MessageId,
  type OrchestrationProjectShell,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { restoreAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { type ReactNode, useContext, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/runtime.ts";

import {
  attachmentEnvironment,
  environmentProjects,
  environmentSession,
  environmentThreadDetails,
  operateAccessAtom,
  serverEnvironment,
  threadEnvironment,
} from "../state.ts";
import {
  acceptImages,
  defaultNewThreadSettings,
  type DraftImage,
  effortBars,
  type MenuProject,
  menuProviders,
  modelEffort,
  type ProviderChoice,
  providerChoices,
  type TurnDraft,
  type TurnSettings,
  turnSettings,
  withOption,
} from "./composer.logic.ts";
import { deriveInitialThreadTitle } from "../home/home.logic.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";

export const RUNTIME_MODE_TEXT: Record<RuntimeMode, string> = {
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
const NO_IMAGES: ReadonlyArray<DraftImage> = [];

async function readImage(file: File): Promise<DraftImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
  return {
    key: SecureRandom.uuidV4Unsafe(),
    file,
    name: file.name || "imagen",
    // acceptImages let only these through.
    mimeType: PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
      (type) => type === file.type.toLowerCase(),
    )!,
    sizeBytes: file.size,
    preview: dataUrl,
  };
}

type Registry = Parameters<typeof runAtomCommand>[0];

// The upload URL is signed for this one file, so the request carries no credential of its own.
async function postBytes(url: string, image: DraftImage, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": image.mimeType },
    body: image.file,
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

const releaseUploads = (
  registry: Registry,
  environmentId: EnvironmentId,
  ids: ReadonlyArray<string>,
) => {
  for (const attachmentId of ids) {
    deletePendingAttachmentUpload({
      registry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId,
    });
  }
};

/**
 * Uploads the images as T3's own composers do: a signed slot per file over the session, then the
 * bytes to it. The message then names them by id; an upload that fails takes the others back.
 */
async function uploadImages(
  registry: Registry,
  environmentId: EnvironmentId,
  images: ReadonlyArray<DraftImage>,
): Promise<{ attachments: ReadonlyArray<ChatImageAttachment> } | { error: string }> {
  const httpBaseUrl = Option.match(
    registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    { onNone: () => null, onSome: (connection) => connection.httpBaseUrl },
  );
  const results = await Promise.all(
    images.map((image) =>
      Effect.runPromise(
        runAttachmentUploadCycle({
          registry,
          createUploadUrl: attachmentEnvironment.createUploadUrl,
          remove: attachmentEnvironment.remove,
          environmentId,
          upload: { name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes },
          resolveUploadUrl: (relativeUrl) =>
            httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, relativeUrl),
          transport: (url) =>
            Effect.tryPromise({
              try: (signal) => postBytes(url, image, signal),
              catch: attachmentUploadError,
            }),
        }),
      ),
    ),
  );
  const uploaded = results.flatMap((result) =>
    result.status === "uploaded" ? [result.attachmentId] : [],
  );
  const failed = results.findIndex((result) => result.status === "failed");
  if (failed >= 0) {
    releaseUploads(registry, environmentId, [
      ...uploaded,
      ...results.flatMap((result) =>
        result.status === "failed" && result.attachmentId !== null ? [result.attachmentId] : [],
      ),
    ]);
    return { error: `No se pudo subir «${images[failed]!.name}».` };
  }
  return {
    attachments: images.map((image, index) => ({
      type: "image",
      id: uploaded[index]!,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    })),
  };
}

/** Runs one thread command; the failure comes back as Spanish text, never thrown. */
export async function runCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  registry: Parameters<typeof runAtomCommand>[0],
  command: AtomCommand<W, A, E>,
  input: W,
  failure: string,
  onSuccess?: (value: A) => void,
): Promise<string | null> {
  const result = await runAtomCommand(registry, command, input, { reportFailure: false });
  if (result._tag === "Success") {
    onSuccess?.(result.value);
    return null;
  }
  const error = squashAtomCommandFailure(result);
  const detail = isAuthorizationError(error)
    ? `la máquina pide el permiso ${error.requiredScope}, que esta sesión no tiene`
    : // An older server answers a method it lacks with this defect.
      error instanceof Error && error.message.startsWith("Unknown request tag: ")
      ? "esta máquina tiene un servidor T3 anterior que aún no tiene esta función; elige otra o actualízala"
      : errorDisplayMessage(error);
  return detail === null ? `${failure}.` : `${failure}: ${detail}`;
}

interface Choice<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
}

/** A labelled menu of radio choices; choosing one closes it. */
function Picker<T extends string>(props: {
  label: string;
  current: ReactNode;
  /** A chip: small and quiet, for the settings that rarely change. */
  compact?: boolean;
  groups: ReadonlyArray<{ readonly label?: string; readonly choices: ReadonlyArray<Choice<T>> }>;
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    // Not modal: a press on the next picker closes this menu and opens that one in one click.
    <Menu modal={false}>
      <MenuTrigger
        type="button"
        className={props.compact ? "ade-picker ade-picker-chip" : "ade-picker"}
      >
        <span className="ade-sr-only">{props.label}: </span>
        {props.current}
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="ade-picker-menu"
      >
        {props.groups.map((group, index) => (
          <MenuRadioGroup
            key={group.label ?? index}
            value={props.selected}
            onValueChange={props.onSelect}
          >
            {group.label === undefined ? null : <MenuGroupLabel>{group.label}</MenuGroupLabel>}
            {group.choices.map((choice) => (
              <MenuRadioItem key={choice.value} value={choice.value} closeOnSelect>
                <MenuItemIndicator keepMounted />
                {choice.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        ))}
      </MenuContent>
    </Menu>
  );
}

const modelKey = (instanceId: string, slug: string) => JSON.stringify([instanceId, slug]);

/** Rising bars, one per level, filled up to the current one; colour follows the text. */
function EffortGlyph(props: { count: number; filled: number }) {
  const height = 12;
  const width = props.count * 4 - 2;
  // Bars rise in whole pixels from about half height, so they stay sharp on 1x screens.
  const step = Math.max(1, Math.round(height / 2 / Math.max(props.count - 1, 1)));
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {Array.from({ length: props.count }, (_, index) => {
        const bar = height - (props.count - 1 - index) * step;
        return (
          <rect
            key={index}
            x={index * 4}
            y={height - bar}
            width={2}
            height={bar}
            fill="currentColor"
            opacity={index < props.filled ? 1 : 0.35}
          />
        );
      })}
    </svg>
  );
}

function SettingsPickers(props: {
  defaults: TurnSettings;
  providers: ReadonlyArray<ProviderChoice>;
  project: MenuProject | null;
  draft: TurnDraft;
  setDraft: (update: (draft: TurnDraft) => TurnDraft) => void;
}) {
  const { defaults, providers } = props;
  const settings = turnSettings(props.draft, defaults, providers);
  const provider = providers.find((choice) => choice.instanceId === settings.model.instanceId);
  const model = provider?.models.find((choice) => choice.slug === settings.model.model);
  const modelName = model?.name;
  const effort = model === undefined ? null : modelEffort(model.descriptors, settings.model);
  return (
    <div className="ade-composer-settings">
      <Picker
        label="Modelo"
        current={
          modelName === undefined ? (
            `${settings.model.model} (no disponible)`
          ) : (
            <>
              <ProviderIcon provider={provider!} />
              <span className="ade-sr-only">{provider!.label} · </span>
              {modelName}
            </>
          )
        }
        groups={menuProviders(providers, props.project, [settings.model, defaults.model]).map(
          (choice) => ({
            label: choice.label,
            choices: choice.models.map((model) => ({
              value: modelKey(choice.instanceId, model.slug),
              label: (
                <>
                  <ProviderIcon provider={choice} />
                  {model.name}
                </>
              ),
            })),
          }),
        )}
        selected={modelKey(settings.model.instanceId, settings.model.model)}
        onSelect={(value) => {
          const [instanceId, slug] = JSON.parse(value) as [string, string];
          const chosen = providers.find((choice) => choice.instanceId === instanceId);
          if (chosen === undefined) return;
          const own = defaults.model;
          props.setDraft((draft) => ({
            ...draft,
            // The default model keeps its options, such as reasoning effort.
            model:
              own.instanceId === instanceId && own.model === slug
                ? own
                : { instanceId: chosen.instanceId, model: slug },
          }));
        }}
      />
      {effort === null ? null : (
        <Picker
          label="Esfuerzo"
          compact
          current={
            <>
              {effort.bars === null ? null : <EffortGlyph {...effort.bars} />}
              <span className={effort.bars === null ? undefined : "ade-sr-only"}>
                {effort.label ?? effort.current ?? "Por defecto"}
              </span>
            </>
          }
          groups={[
            {
              label: effort.descriptor.label,
              choices: selectableProviderOptionChoices(effort.descriptor).map((option) => {
                const bars = effortBars(effort.descriptor, option.id);
                return {
                  value: option.id,
                  label: (
                    <>
                      {option.label}
                      {bars === null ? null : <EffortGlyph {...bars} />}
                    </>
                  ),
                };
              }),
            },
          ]}
          selected={effort.current ?? ""}
          onSelect={(value) =>
            props.setDraft((draft) => ({
              ...draft,
              model: withOption(settings.model, effort.descriptor.id, value),
            }))
          }
        />
      )}
      <Picker
        label="Modo"
        compact
        current={
          <>
            <ShieldCheckIcon size={14} aria-hidden />
            {RUNTIME_MODE_TEXT[settings.runtimeMode]}
          </>
        }
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
          compact
          current={
            <>
              <ListChecksIcon size={14} aria-hidden />
              {INTERACTION_MODE_TEXT[settings.interactionMode]}
            </>
          }
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

interface SendPayload {
  readonly typed: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatImageAttachment>;
  readonly settings: TurnSettings;
}

function ComposerForm(props: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ProviderChoice>;
  project: MenuProject | null;
  defaults: TurnSettings | null;
  draft: TurnDraft;
  setDraft: (update: (draft: TurnDraft) => TurnDraft) => void;
  readOnlyReason: string | null;
  unavailableReason?: string | null;
  placeholder: string;
  submitLabel: string;
  stopThreadRef?: ScopedThreadRef | undefined;
  onSend: (payload: SendPayload) => Promise<string | null>;
}) {
  const { environmentId, providers, defaults, draft, setDraft } = props;
  const registry = useContext(RegistryContext);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const images = draft.images ?? NO_IMAGES;
  const files = useRef<HTMLInputElement>(null);
  const addImages = async (picked: ReadonlyArray<File>) => {
    const { accepted, error: refused } = acceptImages(images, picked);
    setError(refused);
    if (accepted.length === 0) return;
    const read = await Promise.all(accepted.map(readImage)).catch(() => null);
    if (read === null) {
      setError("No se pudo leer la imagen.");
      return;
    }
    setDraft((current) => ({ ...current, images: [...(current.images ?? []), ...read] }));
  };
  const removeImage = (key: string) =>
    setDraft((current) => ({
      ...current,
      images: (current.images ?? []).filter((image) => image.key !== key),
    }));

  const settings = defaults === null ? null : turnSettings(draft, defaults, providers);
  const provider =
    settings === null
      ? undefined
      : providers.find((choice) => choice.instanceId === settings.model.instanceId);
  // Said before sending: the machine would take the message and then fail its turn.
  const imagesRefused =
    images.length > 0 && provider?.takesImages === false
      ? `${provider.label} no admite imágenes: quítalas o elige otro proveedor para enviar.`
      : null;

  const send = async () => {
    const typed = draft.text;
    const sentImages = images;
    if (
      sending ||
      settings === null ||
      imagesRefused !== null ||
      (typed.trim() === "" && sentImages.length === 0)
    ) {
      return;
    }
    // The agent needs words to start a turn: images alone go with T3's own placeholder.
    const text = restoreAttachmentOnlyBootstrapPrompt(typed, sentImages.length > 0);
    setSending(true);
    setError(null);
    const upload =
      sentImages.length === 0
        ? { attachments: [] }
        : await uploadImages(registry, environmentId, sentImages);
    if ("error" in upload) {
      setSending(false);
      setError(upload.error);
      return;
    }
    const failure = await props.onSend({
      typed,
      text,
      attachments: upload.attachments,
      settings,
    });
    setSending(false);
    setError(failure);
    if (failure !== null) {
      releaseUploads(
        registry,
        environmentId,
        upload.attachments.map((attachment) => attachment.id),
      );
    }
    // Text typed and images added while the message was on its way stay.
    if (failure === null)
      setDraft((current) => ({
        ...current,
        text: current.text === typed ? "" : current.text,
        images: (current.images ?? []).filter((image) => !sentImages.includes(image)),
      }));
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
          placeholder={props.placeholder}
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
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (pasted.length === 0) return;
            // A screenshot comes in as a file; text pasted with it stays out, as in T3.
            event.preventDefault();
            void addImages(pasted);
          }}
        />
        {images.length === 0 ? null : (
          <ul className="ade-composer-images" aria-label="Imágenes adjuntas">
            {images.map((image) => (
              <li key={image.key}>
                <img src={image.preview} alt={image.name} />
                <button
                  type="button"
                  aria-label={`Quitar ${image.name}`}
                  onClick={() => removeImage(image.key)}
                >
                  <XIcon size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="ade-composer-bar">
          <input
            ref={files}
            type="file"
            hidden
            multiple
            accept={PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join(",")}
            onChange={(event) => {
              const picked = [...(event.currentTarget.files ?? [])];
              // The same file can be picked again after it was removed.
              event.currentTarget.value = "";
              void addImages(picked);
            }}
          />
          <button
            type="button"
            className="ade-composer-icon"
            aria-label="Adjuntar imagen"
            onClick={() => files.current?.click()}
          >
            <PaperclipIcon size={16} aria-hidden />
          </button>
          {defaults === null ? (
            <div className="ade-composer-settings" />
          ) : (
            <SettingsPickers
              defaults={defaults}
              providers={providers}
              project={props.project}
              draft={draft}
              setDraft={setDraft}
            />
          )}
          <div className="ade-composer-actions">
            {props.stopThreadRef === undefined ? null : (
              <StopButton threadRef={props.stopThreadRef} onError={setError} />
            )}
            <button
              type="submit"
              className="ade-composer-send"
              aria-label={props.submitLabel}
              aria-busy={sending}
              disabled={
                sending ||
                settings === null ||
                imagesRefused !== null ||
                (draft.text.trim() === "" && images.length === 0)
              }
            >
              <ArrowUpIcon size={16} weight="bold" aria-hidden />
            </button>
          </div>
        </div>
      </fieldset>
      {props.readOnlyReason === null ? null : (
        <p className="ade-composer-note" role="status">
          {props.readOnlyReason}
        </p>
      )}
      {props.readOnlyReason === null && props.unavailableReason != null ? (
        <p className="ade-composer-note" role="status">
          {props.unavailableReason}
        </p>
      ) : null}
      {imagesRefused === null ? null : (
        <p className="ade-composer-note" role="status">
          {imagesRefused}
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

/** Where the thread's agent works: the machine, its checkout and branch. */
function Workspace(props: { threadRef: ScopedThreadRef; thread: EnvironmentThreadShell }) {
  const machine = useAtomValue(
    environmentCatalog.catalogValueAtom,
    (catalog) => catalog.entries.get(props.threadRef.environmentId)?.target.label ?? null,
  );
  const worktree = props.thread.worktreePath !== null;
  return (
    <p className="ade-composer-where" aria-label="Dónde trabaja">
      {machine === null ? null : (
        <span>
          <DesktopIcon size={13} aria-hidden />
          {machine}
        </span>
      )}
      <span>
        {worktree ? (
          <TreeStructureIcon size={13} aria-hidden />
        ) : (
          <FolderSimpleIcon size={13} aria-hidden />
        )}
        {worktree ? "Worktree" : "Checkout local"}
      </span>
      {props.thread.branch === null ? null : (
        <span>
          <GitBranchIcon size={13} aria-hidden />
          {props.thread.branch}
        </span>
      )}
    </p>
  );
}

/** The selected thread's composer, with its queue above it and where it works below. */
export function Composer(props: {
  threadRef: ScopedThreadRef;
  thread: EnvironmentThreadShell;
  /** What sits above the queue, such as the work the agent left going. */
  children?: ReactNode;
}) {
  const { threadRef, thread } = props;
  const registry = useContext(RegistryContext);
  const access = useAtomValue(operateAccessAtom(threadRef.environmentId));
  const [draft, setDraft] = useAtom(draftAtom(scopedThreadKey(threadRef)));
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const providers = useMemo(
    () => (config === null ? NO_PROVIDERS : providerChoices(config, thread.projectId)),
    [config, thread.projectId],
  );
  const project = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(threadRef.environmentId),
    (index) => index.get(thread.projectId) ?? null,
  );
  const running =
    useAtomValue(environmentThreadDetails.queueWorkflowAtom(threadRef))?.activeRun != null;
  const defaults: TurnSettings = {
    model: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  };
  return (
    <section className="ade-composer" aria-label="Compositor">
      {props.children}
      <QueuedRuns threadRef={threadRef} />
      <ComposerForm
        environmentId={threadRef.environmentId}
        providers={providers}
        project={project}
        defaults={defaults}
        draft={draft}
        setDraft={setDraft}
        readOnlyReason={access === "operate" ? null : READ_ONLY_TEXT[access ?? "loading"]}
        placeholder={
          running ? "Escribe; se enviará cuando termine este turno" : "Escribe un mensaje"
        }
        submitLabel={running ? "Poner en cola" : "Enviar"}
        stopThreadRef={running ? threadRef : undefined}
        onSend={async ({ text, attachments, settings }) => {
          const target = { environmentId: threadRef.environmentId };
          const threadId = threadRef.threadId;
          // The thread keeps its modes between turns, so a changed one is set before the message.
          return (
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
                    attachments,
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
            ))
          );
        }}
      />
      <Workspace threadRef={threadRef} thread={thread} />
    </section>
  );
}

// Shared across project chips on Inicio so switching projects keeps the typed prompt and images.
const homePromptAtom = Atom.make<Pick<TurnDraft, "text" | "images">>({ text: "" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-home-prompt"),
);
const homeOverridesAtom = Atom.family((_projectKey: string) =>
  Atom.make<Partial<TurnSettings>>({}).pipe(Atom.keepAlive),
);
interface PendingLaunch {
  readonly projectKey: string;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
}
// Reused on retry so a lost response replays the same launch instead of creating a duplicate thread.
const homePendingLaunchAtom = Atom.make<PendingLaunch | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-home-pending-launch"),
);

/** Composer for Inicio: creates a new thread in the chosen machine & project and opens it. */
export function NewThreadComposer(props: {
  environmentId: EnvironmentId;
  machineLabel: string;
  project: OrchestrationProjectShell;
  onEngage?: (() => void) | undefined;
  onThreadCreated: (threadKey: string) => void;
}) {
  const { environmentId, machineLabel, project, onEngage, onThreadCreated } = props;
  const projectKey = `${environmentId}:${project.id}`;
  const registry = useContext(RegistryContext);
  const access = useAtomValue(operateAccessAtom(environmentId));
  const [prompt, setPrompt] = useAtom(homePromptAtom);
  const [overrides, setOverrides] = useAtom(homeOverridesAtom(projectKey));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers = useMemo(
    () => (config === null ? NO_PROVIDERS : providerChoices(config, project.id)),
    [config, project.id],
  );
  const defaults = useMemo(
    () =>
      config === null ? null : defaultNewThreadSettings(config, project.id, providers, project),
    [config, project, providers],
  );
  const draft: TurnDraft = { ...overrides, ...prompt };
  const setDraft = (update: (current: TurnDraft) => TurnDraft) => {
    const next = update({
      ...registry.get(homeOverridesAtom(projectKey)),
      ...registry.get(homePromptAtom),
    });
    if (
      next.text !== "" ||
      (next.images?.length ?? 0) > 0 ||
      next.model !== undefined ||
      next.runtimeMode !== undefined ||
      next.interactionMode !== undefined
    ) {
      onEngage?.();
    }
    setPrompt({ text: next.text, ...(next.images === undefined ? {} : { images: next.images }) });
    setOverrides({
      ...(next.model === undefined ? {} : { model: next.model }),
      ...(next.runtimeMode === undefined ? {} : { runtimeMode: next.runtimeMode }),
      ...(next.interactionMode === undefined ? {} : { interactionMode: next.interactionMode }),
    });
  };
  const unavailableReason =
    defaults !== null
      ? null
      : config === null
        ? "Cargando proveedores de esta máquina…"
        : "No hay proveedores disponibles en esta máquina para este proyecto.";

  return (
    <section className="ade-composer ade-composer-home" aria-label="Compositor">
      <ComposerForm
        environmentId={environmentId}
        providers={providers}
        project={project}
        defaults={defaults}
        draft={draft}
        setDraft={setDraft}
        readOnlyReason={access === "operate" ? null : READ_ONLY_TEXT[access ?? "loading"]}
        unavailableReason={unavailableReason}
        placeholder="¿Qué hacemos?"
        submitLabel="Crear hilo"
        onSend={async ({ typed, text, attachments, settings }) => {
          const existing = registry.get(homePendingLaunchAtom);
          const attempt: PendingLaunch =
            existing !== null && existing.projectKey === projectKey
              ? existing
              : {
                  projectKey,
                  threadId: ThreadId.make(SecureRandom.uuidV4Unsafe()),
                  commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                  messageId: MessageId.make(SecureRandom.uuidV4Unsafe()),
                };
          if (existing !== attempt) registry.set(homePendingLaunchAtom, attempt);
          const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
          const title = deriveInitialThreadTitle(typed);
          return await runCommand(
            registry,
            threadEnvironment.startTurn,
            {
              environmentId,
              input: {
                commandId: attempt.commandId,
                threadId: attempt.threadId,
                message: {
                  messageId: attempt.messageId,
                  role: "user",
                  text,
                  attachments,
                },
                modelSelection: settings.model,
                titleSeed: title,
                runtimeMode: settings.runtimeMode,
                interactionMode: settings.interactionMode,
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title,
                    modelSelection: settings.model,
                    runtimeMode: settings.runtimeMode,
                    interactionMode: settings.interactionMode,
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                },
                createdAt,
              },
            },
            "No se pudo crear el hilo",
            () => {
              registry.set(homePendingLaunchAtom, null);
              onThreadCreated(scopedThreadKey(scopeThreadRef(environmentId, attempt.threadId)));
            },
          );
        }}
      />
      <p className="ade-composer-where" aria-label="Dónde empieza">
        <span>
          <DesktopIcon size={13} aria-hidden />
          {machineLabel}
        </span>
        <span>
          <FolderSimpleIcon size={13} aria-hidden />
          {project.title}
        </span>
        <span>Checkout local</span>
      </p>
    </section>
  );
}
