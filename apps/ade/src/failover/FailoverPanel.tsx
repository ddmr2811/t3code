import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  type EnvironmentId,
  FORK_FAILOVER_MAX_CHAINS,
  FORK_FAILOVER_MAX_COOLDOWN_SECONDS,
  FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW,
  FORK_FAILOVER_MAX_TARGETS_PER_CHAIN,
  FORK_FAILOVER_MIN_COOLDOWN_SECONDS,
  FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW,
  type ForkFailoverConfig,
  type ForkFailoverEvent,
  type ForkFailoverEventStatus,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { type FormEvent, useContext, useMemo, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import { selectedThreadKeyAtom } from "../sidebar/Sidebar.tsx";
import { serverEnvironment } from "../state.ts";
import {
  availableMachineModelOptions,
  buildSafeChainId,
  type FailoverChainDraft,
  type FailoverConfigDraft,
  failoverTargetKey,
  formatFailoverTargetLabel,
  type MachineModelOption,
  moveTargetInChain,
  validateFailoverConfigDraft,
} from "./failover.logic.ts";
import {
  allFailoverStatesAtom,
  forkFailoverSetConfigCommand,
  refreshFailoverState,
} from "./failover.state.ts";

const EVENT_STATUS_LABEL: Record<ForkFailoverEventStatus, string> = {
  switched: "Cambiado",
  skipped: "Omitido",
  failed: "Error",
};

function formatEventTime(iso: string): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  return DateTime.formatLocal(parsed.value, {
    locale: "es-ES",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDraft(config: ForkFailoverConfig): FailoverConfigDraft {
  return {
    enabled: config.enabled,
    cooldownSeconds: config.cooldownSeconds,
    maxSwitchesPerWindow: config.maxSwitchesPerWindow,
    chains: config.chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      ...(chain.matchInstanceId === undefined ? {} : { matchInstanceId: chain.matchInstanceId }),
      ...(chain.matchModel === undefined ? {} : { matchModel: chain.matchModel }),
      targets: [...chain.targets],
    })),
  };
}

function MachineFailoverEditor(props: {
  environmentId: EnvironmentId;
  machineLabel: string;
  config: ForkFailoverConfig;
  modelOptions: ReadonlyArray<MachineModelOption>;
}) {
  const registry = useContext(RegistryContext);
  const canManage = useAtomValue(forkFailoverSetConfigCommand.permissionAtom(props.environmentId));
  const [draft, setDraft] = useState<FailoverConfigDraft>(() => toDraft(props.config));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [selectedAddByChain, setSelectedAddByChain] = useState<Record<string, string>>({});

  const effectiveDraft = dirty ? draft : toDraft(props.config);

  const uniqueInstances = useMemo(() => {
    const map = new Map<ProviderInstanceId, string>();
    for (const option of props.modelOptions) {
      if (!map.has(option.instanceId)) map.set(option.instanceId, option.providerLabel);
    }
    return [...map.entries()];
  }, [props.modelOptions]);

  const updateDraft = (updater: (current: FailoverConfigDraft) => FailoverConfigDraft) => {
    setSavedNotice(null);
    setError(null);
    setDraft((current) => updater(dirty ? current : toDraft(props.config)));
    setDirty(true);
  };

  const addChain = () => {
    if (effectiveDraft.chains.length >= FORK_FAILOVER_MAX_CHAINS) return;
    const existingIds = new Set(effectiveDraft.chains.map((chain) => chain.id));
    const defaultName =
      effectiveDraft.chains.length === 0
        ? "Respaldo por defecto"
        : `Cadena ${effectiveDraft.chains.length + 1}`;
    const firstOption = props.modelOptions[0];
    const secondOption = props.modelOptions[1];
    const initialTargets = [firstOption, secondOption]
      .filter((option): option is MachineModelOption => option !== undefined)
      .map((option) => ({ instanceId: option.instanceId, model: option.model }));
    updateDraft((current) => ({
      ...current,
      chains: [
        ...current.chains,
        {
          id: buildSafeChainId(existingIds, defaultName),
          name: defaultName,
          targets: initialTargets,
        },
      ],
    }));
  };

  const updateChain = (
    chainIndex: number,
    updater: (chain: FailoverChainDraft) => FailoverChainDraft,
  ) => {
    updateDraft((current) => ({
      ...current,
      chains: current.chains.map((chain, index) => (index === chainIndex ? updater(chain) : chain)),
    }));
  };

  const removeChain = (chainIndex: number) => {
    updateDraft((current) => ({
      ...current,
      chains: current.chains.filter((_, index) => index !== chainIndex),
    }));
  };

  const addTargetToChain = (chainIndex: number, chain: FailoverChainDraft) => {
    if (chain.targets.length >= FORK_FAILOVER_MAX_TARGETS_PER_CHAIN) return;
    const unusedOptions = props.modelOptions.filter(
      (option) =>
        !chain.targets.some((target) => failoverTargetKey(target) === failoverTargetKey(option)),
    );
    const rawSelection = selectedAddByChain[chain.id];
    const picked =
      unusedOptions.find((option) => failoverTargetKey(option) === rawSelection) ??
      unusedOptions[0];
    if (picked === undefined) return;
    updateChain(chainIndex, (current) => ({
      ...current,
      targets: [...current.targets, { instanceId: picked.instanceId, model: picked.model }],
    }));
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const validated = validateFailoverConfigDraft(effectiveDraft);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    const failure = await runCommand(
      registry,
      forkFailoverSetConfigCommand,
      { environmentId: props.environmentId, input: { config: validated.config } },
      "No se pudo guardar la política de respaldo",
    );
    setBusy(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    setDirty(false);
    setSavedNotice(`Configuración guardada en ${props.machineLabel}.`);
    refreshFailoverState(registry, props.environmentId);
  };

  return (
    <form className="ade-failover-form" onSubmit={(event) => void handleSave(event)}>
      <fieldset className="ade-failover-fieldset" disabled={!canManage || busy}>
        <legend className="ade-sr-only">Política de respaldo de {props.machineLabel}</legend>

        <label className="ade-failover-toggle">
          <input
            type="checkbox"
            checked={effectiveDraft.enabled}
            onChange={(event) =>
              updateDraft((current) => ({ ...current, enabled: event.currentTarget.checked }))
            }
          />
          <span>
            <strong>Activar failover automático por límite de cuota</strong>
            <small>
              Ante un error <code>usage_limit</code> / 429, cambia al siguiente modelo disponible
              conservando hilo, historial, worktree y permisos.
            </small>
          </span>
        </label>

        <div className="ade-failover-limits">
          <label>
            Enfriamiento (segundos)
            <input
              type="number"
              min={FORK_FAILOVER_MIN_COOLDOWN_SECONDS}
              max={FORK_FAILOVER_MAX_COOLDOWN_SECONDS}
              value={effectiveDraft.cooldownSeconds}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  cooldownSeconds: Number(event.currentTarget.value),
                }))
              }
            />
          </label>
          <label>
            Máx. relevos por ventana (anti-bucle)
            <input
              type="number"
              min={FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW}
              max={FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW}
              value={effectiveDraft.maxSwitchesPerWindow}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  maxSwitchesPerWindow: Number(event.currentTarget.value),
                }))
              }
            />
          </label>
        </div>

        <div className="ade-failover-chains-header">
          <div>
            <h2>Cadenas de respaldo</h2>
            <p className="ade-projects-subtitle">
              Se evalúa la cadena más específica (instancia + modelo → instancia → por defecto) en
              orden de arriba abajo.
            </p>
          </div>
          <button
            type="button"
            className="ade-button-quiet"
            disabled={
              !canManage ||
              busy ||
              props.modelOptions.length === 0 ||
              effectiveDraft.chains.length >= FORK_FAILOVER_MAX_CHAINS
            }
            onClick={addChain}
          >
            <PlusIcon size={14} aria-hidden />
            <span>Añadir cadena</span>
          </button>
        </div>

        {props.modelOptions.length === 0 ? (
          <p className="ade-projects-subtitle">
            Esta máquina aún no publica proveedores activos con modelos disponibles.
          </p>
        ) : null}

        {effectiveDraft.chains.length === 0 ? (
          <section className="ade-projects-empty">
            <p>Sin cadenas configuradas en {props.machineLabel}.</p>
          </section>
        ) : (
          <div className="ade-failover-chains">
            {effectiveDraft.chains.map((chain, chainIndex) => {
              const unusedOptions = props.modelOptions.filter(
                (option) =>
                  !chain.targets.some(
                    (target) => failoverTargetKey(target) === failoverTargetKey(option),
                  ),
              );
              const selectedAdd =
                selectedAddByChain[chain.id] ??
                (unusedOptions[0] === undefined ? "" : failoverTargetKey(unusedOptions[0]));
              return (
                <article key={chain.id} className="ade-failover-chain">
                  <header className="ade-failover-chain-head">
                    <label className="ade-failover-chain-name">
                      Nombre de la cadena
                      <input
                        value={chain.name}
                        maxLength={120}
                        required
                        onChange={(event) =>
                          updateChain(chainIndex, (current) => ({
                            ...current,
                            name: event.currentTarget.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="ade-button-quiet"
                      aria-label={`Eliminar cadena ${chain.name}`}
                      onClick={() => removeChain(chainIndex)}
                    >
                      <TrashIcon size={14} aria-hidden />
                      <span>Quitar</span>
                    </button>
                  </header>

                  <div className="ade-failover-chain-matchers">
                    <label>
                      Aplica a instancia
                      <select
                        value={chain.matchInstanceId ?? ""}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          updateChain(chainIndex, (current) => {
                            const { matchInstanceId: _prev, ...rest } = current;
                            return raw === ""
                              ? rest
                              : { ...rest, matchInstanceId: raw as ProviderInstanceId };
                          });
                        }}
                      >
                        <option value="">Cualquier instancia (por defecto)</option>
                        {uniqueInstances.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Modelo origen (opcional)
                      <input
                        value={chain.matchModel ?? ""}
                        maxLength={160}
                        placeholder="Ej. gpt-5.4 (vacío = cualquiera)"
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          updateChain(chainIndex, (current) => {
                            const { matchModel: _prev, ...rest } = current;
                            return raw === "" ? rest : { ...rest, matchModel: raw };
                          });
                        }}
                      />
                    </label>
                  </div>

                  <ol className="ade-failover-targets" aria-label={`Modelos de ${chain.name}`}>
                    {chain.targets.map((target, targetIndex) => (
                      <li key={failoverTargetKey(target)} className="ade-failover-target-row">
                        <span className="ade-failover-target-rank">{targetIndex + 1}</span>
                        <span className="ade-failover-target-label">
                          {formatFailoverTargetLabel(target, props.modelOptions)}
                        </span>
                        <div className="ade-failover-target-actions">
                          <button
                            type="button"
                            className="ade-button-quiet"
                            aria-label="Subir prioridad"
                            disabled={targetIndex === 0}
                            onClick={() =>
                              updateChain(chainIndex, (current) => ({
                                ...current,
                                targets: moveTargetInChain(current.targets, targetIndex, -1),
                              }))
                            }
                          >
                            <ArrowUpIcon size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="ade-button-quiet"
                            aria-label="Bajar prioridad"
                            disabled={targetIndex === chain.targets.length - 1}
                            onClick={() =>
                              updateChain(chainIndex, (current) => ({
                                ...current,
                                targets: moveTargetInChain(current.targets, targetIndex, 1),
                              }))
                            }
                          >
                            <ArrowDownIcon size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="ade-button-quiet"
                            aria-label={`Quitar ${target.model}`}
                            onClick={() =>
                              updateChain(chainIndex, (current) => ({
                                ...current,
                                targets: current.targets.filter(
                                  (_, index) => index !== targetIndex,
                                ),
                              }))
                            }
                          >
                            <TrashIcon size={14} aria-hidden />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>

                  {unusedOptions.length > 0 &&
                  chain.targets.length < FORK_FAILOVER_MAX_TARGETS_PER_CHAIN ? (
                    <div className="ade-failover-add-target">
                      <select
                        aria-label={`Elegir modelo para ${chain.name}`}
                        value={selectedAdd}
                        onChange={(event) =>
                          setSelectedAddByChain((current) => ({
                            ...current,
                            [chain.id]: event.currentTarget.value,
                          }))
                        }
                      >
                        {unusedOptions.map((option) => {
                          const key = failoverTargetKey(option);
                          return (
                            <option key={key} value={key}>
                              {option.providerLabel} · {option.modelName}
                            </option>
                          );
                        })}
                      </select>
                      <button
                        type="button"
                        className="ade-button-quiet"
                        onClick={() => addTargetToChain(chainIndex, chain)}
                      >
                        <PlusIcon size={14} aria-hidden />
                        <span>Añadir modelo</span>
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </fieldset>

      {canManage ? null : (
        <p className="ade-composer-note" role="status">
          Solo lectura: esta sesión necesita el permiso <code>providers:manage</code> en{" "}
          {props.machineLabel} para editar el respaldo automático.
        </p>
      )}

      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
      {savedNotice === null ? null : (
        <p className="ade-failover-notice" role="status">
          {savedNotice}
        </p>
      )}

      <div className="ade-coord-form-actions">
        {dirty ? (
          <button
            type="button"
            className="ade-button-quiet"
            disabled={busy}
            onClick={() => {
              setDirty(false);
              setError(null);
            }}
          >
            Descartar
          </button>
        ) : null}
        <button type="submit" className="ade-button" disabled={!canManage || busy}>
          {busy ? "Guardando…" : "Guardar configuración"}
        </button>
      </div>
    </form>
  );
}

function FailoverHistory(props: {
  environmentId: EnvironmentId;
  events: ReadonlyArray<ForkFailoverEvent>;
  modelOptions: ReadonlyArray<MachineModelOption>;
  onOpenThread: (key: string) => void;
}) {
  return (
    <section className="ade-failover-history">
      <h2>Historial reciente de relevos</h2>
      {props.events.length === 0 ? (
        <p className="ade-projects-subtitle">
          Aún no se ha registrado ningún relevo de modelo en esta máquina.
        </p>
      ) : (
        <ul className="ade-failover-events">
          {props.events.map((event) => {
            const threadKey = scopedThreadKey(scopeThreadRef(props.environmentId, event.threadId));
            return (
              <li key={event.id} className="ade-failover-event" data-failover-status={event.status}>
                <div className="ade-failover-event-head">
                  <span className="ade-chip" data-failover-status={event.status}>
                    {EVENT_STATUS_LABEL[event.status]}
                  </span>
                  <span className="ade-chip">{event.reason}</span>
                  <span className="ade-coord-updated">{formatEventTime(event.occurredAt)}</span>
                </div>
                <p className="ade-failover-event-route">
                  {formatFailoverTargetLabel(event.fromSelection, props.modelOptions)}
                  {" → "}
                  {event.toSelection === null
                    ? "Sin cambio"
                    : formatFailoverTargetLabel(event.toSelection, props.modelOptions)}
                </p>
                {event.detail.length > 0 ? (
                  <p className="ade-failover-event-detail">{event.detail}</p>
                ) : null}
                <div className="ade-failover-event-actions">
                  <button
                    type="button"
                    className="ade-backlayer-link"
                    onClick={() => props.onOpenThread(threadKey)}
                  >
                    <ArrowSquareOutIcon size={14} aria-hidden />
                    <span>Abrir hilo</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const NO_SERVER_CONFIG = Atom.make<ServerConfig | null>(null);

export function FailoverPanel() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { byEnv, loadingCount, errors } = useAtomValue(allFailoverStatesAtom);
  const openThread = useAtomSet(selectedThreadKeyAtom);

  const enabledEnvs = useMemo(() => [...enabledEnvironmentIds(catalog)], [catalog]);
  const [selectedEnvState, setSelectedEnv] = useState<EnvironmentId | null>(null);
  const selectedEnv =
    selectedEnvState !== null && enabledEnvs.includes(selectedEnvState)
      ? selectedEnvState
      : (enabledEnvs[0] ?? null);

  const machineLabels = useMemo(
    () =>
      new Map(
        [...catalog.entries].map(([environmentId, entry]) => [environmentId, entry.target.label]),
      ),
    [catalog],
  );

  const selectedServerConfig = useAtomValue(
    selectedEnv === null ? NO_SERVER_CONFIG : serverEnvironment.configValueAtom(selectedEnv),
  );
  const modelOptions = useMemo(
    () => (selectedEnv === null ? [] : availableMachineModelOptions(selectedServerConfig)),
    [selectedEnv, selectedServerConfig],
  );

  const selectedState = selectedEnv === null ? null : (byEnv.get(selectedEnv) ?? null);
  const selectedHasError =
    selectedEnv !== null && errors.some((failure) => failure.environmentId === selectedEnv);

  return (
    <div className="ade-projects ade-failover">
      <header className="ade-projects-header">
        <div>
          <p className="ade-label">Cuota y continuidad</p>
          <h1>Respaldo de modelos</h1>
          <p className="ade-projects-subtitle">
            Relevo automático ante límites de cuota (<code>usage_limit</code> / 429) conservando
            hilo, historial y worktree.
          </p>
        </div>
        {enabledEnvs.length > 1 && selectedEnv !== null ? (
          <label className="ade-failover-machine-picker">
            <span className="ade-sr-only">Máquina</span>
            <select
              value={selectedEnv}
              onChange={(event) => setSelectedEnv(event.currentTarget.value as EnvironmentId)}
            >
              {enabledEnvs.map((id) => (
                <option key={id} value={id}>
                  {machineLabels.get(id) ?? id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {errors.length === 0 ? null : (
        <div className="ade-error" role="status">
          {errors.map((failure) => (
            <p key={failure.environmentId} className="ade-coord-load-error">
              {machineLabels.get(failure.environmentId) ?? failure.environmentId}: {failure.message}
            </p>
          ))}
        </div>
      )}

      {selectedEnv === null ? (
        <section className="ade-projects-empty">
          <p>
            {loadingCount > 0
              ? "Cargando estado de respaldo…"
              : "No hay máquinas habilitadas en este momento."}
          </p>
        </section>
      ) : selectedState === null ? (
        <section className="ade-projects-empty">
          <p>
            {selectedHasError
              ? "No se pudo leer la configuración de respaldo de esta máquina."
              : "Cargando configuración de respaldo…"}
          </p>
        </section>
      ) : (
        <>
          <MachineFailoverEditor
            key={selectedEnv}
            environmentId={selectedEnv}
            machineLabel={machineLabels.get(selectedEnv) ?? selectedEnv}
            config={selectedState.config}
            modelOptions={modelOptions}
          />
          <FailoverHistory
            environmentId={selectedEnv}
            events={selectedState.recentEvents}
            modelOptions={modelOptions}
            onOpenThread={openThread}
          />
        </>
      )}
    </div>
  );
}
