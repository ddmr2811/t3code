import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  FORK_INTEGRATION_GROUPS,
  type EnvironmentId,
  type ForkBotIntegrations,
  type ForkIntegrationApp,
  type ForkIntegrationLevel,
  integrationLevel,
} from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import {
  ALWAYS_ASK_GROUPS,
  INTEGRATION_APP_LABELS,
  INTEGRATION_GROUP_LABELS,
  INTEGRATION_LEVEL_LABELS,
  forkIntegrationsConnectCommand,
  forkIntegrationsListQuery,
  refreshIntegrations,
} from "./integrations.state.ts";

const APPS = Object.keys(FORK_INTEGRATION_GROUPS) as ReadonlyArray<ForkIntegrationApp>;

/** What a bot may do in each connected app, one select per group of actions. */
export function IntegrationLevels(props: {
  value: ForkBotIntegrations;
  onChange: (value: ForkBotIntegrations) => void;
}) {
  return (
    <>
      {APPS.map((app) => (
        <fieldset key={app} className="ade-failover-fieldset">
          <legend className="ade-label">{INTEGRATION_APP_LABELS[app]}</legend>
          <div className="ade-coord-form-grid">
            {FORK_INTEGRATION_GROUPS[app].map((group) => (
              <label key={group}>
                {INTEGRATION_GROUP_LABELS[group] ?? group}
                <select
                  value={integrationLevel(props.value, app, group)}
                  onChange={(event) =>
                    props.onChange({
                      ...props.value,
                      [app]: { ...props.value[app], [group]: event.target.value },
                    })
                  }
                >
                  {(["deny", "ask", "allow"] as const)
                    .filter((level) => level !== "allow" || !ALWAYS_ASK_GROUPS.has(group))
                    .map((level: ForkIntegrationLevel) => (
                      <option key={level} value={level}>
                        {INTEGRATION_LEVEL_LABELS[level]}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <p className="ade-bot-meta">
            Fusionar, borrar, cerrar y subir archivos te lo pregunta siempre. «Sin preguntar» solo
            vale para escribir si el hilo del bot va en auto o acceso total y no en modo plan; si
            no, también pregunta. Nunca escribe en main ni en dev. El bot no ve el token.
          </p>
        </fieldset>
      ))}
    </>
  );
}

/** Whether each app is connected on this machine, and the dialog that stores its token. */
export function IntegrationConnections(props: { environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const result = useAtomValue(forkIntegrationsListQuery({ environmentId, input: {} }));
  const canConnect = useAtomValue(forkIntegrationsConnectCommand.permissionAtom(environmentId));
  const [open, setOpen] = useState<ForkIntegrationApp | null>(null);
  if (result._tag !== "Success") return <span />;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {result.value.apps.map((status) => (
        <button
          key={status.app}
          type="button"
          className="ade-button-quiet"
          onClick={() => setOpen(status.app)}
        >
          {INTEGRATION_APP_LABELS[status.app]}:{" "}
          {status.connected ? `conectado como ${status.account}` : "sin conectar"}
        </button>
      ))}
      {open === null ? null : (
        <ConnectDialog
          app={open}
          connected={result.value.apps.some((status) => status.app === open && status.connected)}
          allowed={canConnect === true}
          onClose={() => setOpen(null)}
          onSubmit={(token) =>
            runCommand(
              registry,
              forkIntegrationsConnectCommand,
              { environmentId, input: { app: open, token } },
              token === null ? "No se pudo desconectar" : "No se pudo conectar",
              () => refreshIntegrations(registry, environmentId),
            )
          }
        />
      )}
    </div>
  );
}

function ConnectDialog(props: {
  app: ForkIntegrationApp;
  connected: boolean;
  allowed: boolean;
  onClose: () => void;
  onSubmit: (token: string | null) => Promise<string | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = INTEGRATION_APP_LABELS[props.app];

  // The native modal dialog traps focus, handles Escape, and returns focus to the opener.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const submit = async (value: string | null) => {
    setBusy(true);
    setError(null);
    const failure = await props.onSubmit(value);
    setBusy(false);
    // The token leaves the page as soon as it was sent, whatever the answer.
    setToken("");
    if (failure !== null) return setError(failure);
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="ade-bots-editor" onClose={props.onClose}>
      <form
        className="ade-coord-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim() !== "") void submit(token.trim());
        }}
      >
        <header className="ade-coord-form-header">
          <h2>Conectar {name}</h2>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => dialog.current?.close()}
          >
            Cerrar
          </button>
        </header>
        {props.allowed ? (
          <>
            <label>
              Token de acceso (fine-grained)
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="ade-bot-meta">
              Se guarda solo en esta máquina y no vuelve a mostrarse. Los bots no lo ven: el
              servidor hace las llamadas por ellos.
            </p>
          </>
        ) : (
          <p className="ade-bot-meta">
            Esta sesión no puede guardar credenciales. Empareja de nuevo la máquina marcando
            «Permitir guardar credenciales de integraciones».
          </p>
        )}
        {error === null ? null : (
          <p className="ade-error" role="alert">
            {error}
          </p>
        )}
        {props.allowed ? (
          <div className="ade-coord-form-actions">
            {props.connected ? (
              <button
                type="button"
                className="ade-button-quiet"
                disabled={busy}
                onClick={() => void submit(null)}
              >
                Desconectar
              </button>
            ) : null}
            <button type="submit" className="ade-button" disabled={busy || token.trim() === ""}>
              {busy ? "Comprobando…" : props.connected ? "Cambiar token" : "Conectar"}
            </button>
          </div>
        ) : null}
      </form>
    </dialog>
  );
}
