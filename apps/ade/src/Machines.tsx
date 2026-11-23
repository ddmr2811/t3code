import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { readHostedPairingRequest } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useContext, useState } from "react";

import { pairMachine, TOKEN_IN_QUERY_TEXT, tokenInQuery } from "./connection/pairing.ts";
import { environmentCatalog } from "./connection/runtime.ts";
import { machineStatus } from "./connection/status.ts";
import { machinesChanged } from "./connection/tabs.ts";

// A link that opens the ADE to pair (`?host=…#token=…`) leaves the address bar before anything
// renders: the one-time token must not stay in the URL, the history, or a later Referer. Only the
// fragment carries a code: one in `?token=` already reached this page's host, so it is not used.
const addressBar = (() => {
  const link = window.location.href;
  const refused = tokenInQuery(link);
  if (!refused && readHostedPairingRequest(new URL(link)) === null) return null;
  window.history.replaceState(null, "", window.location.pathname);
  return refused ? { link: "", error: TOKEN_IN_QUERY_TEXT } : { link, error: null };
})();

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function useMachineStatus(environmentId: EnvironmentId, entry: ConnectionCatalogEntry) {
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  return machineStatus(entry, state);
}

function MachineRow(props: { environmentId: EnvironmentId; entry: ConnectionCatalogEntry }) {
  const registry = useContext(RegistryContext);
  const status = useMachineStatus(props.environmentId, props.entry);
  const label = props.entry.target.label;
  return (
    <li className="ade-machine" data-tone={status.tone}>
      <span className="ade-dot" />
      <span className="ade-machine-name">{label}</span>
      <span className="ade-machine-status">{status.text}</span>
      <button
        type="button"
        className="ade-icon-button"
        aria-label={`Quitar ${label}`}
        onClick={async () => {
          if (
            !window.confirm(
              `¿Quitar ${label}? Este navegador olvida su credencial, pero la sesión sigue viva en la máquina: para revocarla, en T3 Code de ${label} ve a Ajustes → Compartir y acceso → Clientes autorizados.`,
            )
          )
            return;
          const removed = await runAtomCommand(
            registry,
            environmentCatalog.remove,
            props.environmentId,
          );
          if (AsyncResult.isSuccess(removed)) machinesChanged(props.environmentId);
        }}
      >
        <TrashIcon size={14} />
      </button>
    </li>
  );
}

function PairingForm(props: { onDone: () => void }) {
  const registry = useContext(RegistryContext);
  const [link, setLink] = useState(addressBar?.link ?? "");
  const [code, setCode] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(addressBar?.error ?? null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      pairMachine,
      {
        ...(code.trim() === "" ? { pairingUrl: link } : { host: link, pairingCode: code }),
        terminal,
      },
      // The form shows the failure; the console would only repeat it.
      { reportFailure: false },
    );
    setBusy(false);
    if (AsyncResult.isSuccess(result)) return props.onDone();
    const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
    setError(failure?.message ?? "No se pudo emparejar la máquina.");
  };

  return (
    <form className="ade-pairing" onSubmit={submit}>
      <label>
        Enlace de emparejamiento o dirección
        <input
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://maquina:3773/pair#token=…"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        Código (solo si has puesto una dirección)
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="ade-pairing-check">
        <input
          type="checkbox"
          checked={terminal}
          onChange={(event) => setTerminal(event.target.checked)}
        />
        Permitir terminal (un shell en la máquina)
      </label>
      {error !== null && (
        <p className="ade-pairing-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="ade-button" disabled={busy}>
        {busy ? "Emparejando…" : "Emparejar"}
      </button>
    </form>
  );
}

export function MachinesSidebar() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [adding, setAdding] = useState(addressBar !== null);
  const machines = [...catalog.entries];
  return (
    <>
      <div className="ade-label">
        Máquinas
        <button
          type="button"
          className="ade-icon-button"
          aria-label="Añadir máquina"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      {adding && <PairingForm onDone={() => setAdding(false)} />}
      {machines.length === 0 ? (
        <div className="ade-sidebar-empty">
          <HardDrivesIcon size={16} />
          {catalog.isReady ? "Ninguna emparejada" : "Cargando…"}
        </div>
      ) : (
        <ul className="ade-machines">
          {machines.map(([environmentId, entry]) => (
            <MachineRow key={environmentId} environmentId={environmentId} entry={entry} />
          ))}
        </ul>
      )}
    </>
  );
}

export function ConnectionSummary() {
  const machines = useAtomValue(environmentCatalog.catalogValueAtom).entries.size;
  return <>{machines === 0 ? "Sin máquinas" : count(machines, "máquina")}</>;
}
