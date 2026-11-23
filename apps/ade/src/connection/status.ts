import {
  AVAILABLE_CONNECTION_STATE,
  presentConnectionState,
  type ConnectionAttemptError,
  type ConnectionCatalogEntry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

export interface MachineStatus {
  readonly tone: "ok" | "busy" | "error" | "off";
  readonly text: string;
}

const INCOMPATIBLE = `Protocolo incompatible: este ADE habla la versión ${ORCHESTRATION_PROTOCOL_VERSION} y la máquina otra. Actualiza T3 Code en la máquina o el ADE hasta que coincidan.`;

/** Why a connection or a pairing failed, in Spanish. The runtime's own text is English. */
export function failureText(failure: Pick<ConnectionAttemptError, "reason"> | null): string {
  switch (failure?.reason) {
    case "unsupported":
      return INCOMPATIBLE;
    case "authentication":
      return "La máquina rechazó la credencial. Vuelve a emparejarla con un enlace nuevo.";
    case "permission":
      return "La sesión de este ADE no tiene permiso suficiente en la máquina.";
    case "configuration":
      return "La dirección o el enlace de la máquina no es válido.";
    default:
      return "No se pudo llegar a la máquina.";
  }
}

export function machineStatus(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
): MachineStatus {
  if (entry.unsupportedReason !== undefined) return { tone: "error", text: INCOMPATIBLE };
  if (!entry.enabled) return { tone: "off", text: "Desconectada" };
  // The supervisor never publishes this placeholder; an enabled machine starts out connecting.
  if (state === AVAILABLE_CONNECTION_STATE) return { tone: "busy", text: "Conectando…" };
  switch (presentConnectionState(state).phase) {
    case "connected":
      return { tone: "ok", text: "Conectada" };
    case "connecting":
      return { tone: "busy", text: "Conectando…" };
    case "reconnecting":
      return { tone: "busy", text: "Reconectando…" };
    case "offline":
      return { tone: "off", text: "Sin red" };
    case "available":
      return { tone: "off", text: "Desconectada" };
    case "unsupported":
    case "error":
      return { tone: "error", text: failureText(state.lastFailure) };
  }
}
