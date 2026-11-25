import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { NewThreadComposer } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import {
  listedThreadsAtom,
  selectedThreadKeyAtom,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { projectAccentColor, projectMonogram } from "../sidebar/sidebar.logic.ts";
import { environmentProjects, threadEnvironment } from "../state.ts";
import { Overnight } from "./Overnight.tsx";
import { greetingForHour, homeProjects, workingThreadCount } from "./home.logic.ts";

const homeProjectsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const threads = get(listedThreadsAtom);
  const machineIds = [...enabledEnvironmentIds(catalog)];
  const loading = machineIds.some(
    (environmentId) => get(threadEnvironment.snapshotAtom(environmentId)) === null,
  );
  const machines = machineIds.map((environmentId) => ({
    environmentId,
    label: catalog.entries.get(environmentId)?.target.label ?? environmentId,
    projects: get(environmentProjects.environmentProjectsAtom(environmentId)),
  }));
  return {
    projects: homeProjects(machines, threads),
    machineCount: machineIds.length,
    loading,
  };
}).pipe(Atom.withLabel("ade-home-projects"));

const workingCountAtom = Atom.make((get) => workingThreadCount(get(listedThreadsAtom))).pipe(
  Atom.withLabel("ade-home-working-count"),
);

// Kept in memory only so leaving Inicio and returning remembers the picked project without touching localStorage.
const selectedHomeProjectKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-home-selected-project"),
);

export function Home() {
  const { projects, machineCount, loading } = useAtomValue(homeProjectsAtom);
  const workingCount = useAtomValue(workingCountAtom);
  const {
    count: needsYouCount,
    open: decisionsOpen,
    setOpen: setDecisionsOpen,
  } = useDecisionsPanel();
  const [selectedKey, setSelectedKey] = useAtom(selectedHomeProjectKeyAtom);
  const openThread = useAtomSet(selectedThreadKeyAtom);

  const selected =
    (selectedKey === null ? undefined : projects.find((target) => target.key === selectedKey)) ??
    projects[0] ??
    null;
  const multipleMachines = machineCount > 1;
  const greeting = greetingForHour(DateTime.toDate(DateTime.nowUnsafe()).getHours());
  const needsYouText = needsYouCount === 1 ? "1 te necesita" : `${needsYouCount} te necesitan`;

  return (
    <section className="ade-home" aria-label="Inicio">
      <div className="ade-home-inner">
        <header className="ade-home-greeting">
          <h1>{greeting}</h1>
          <p className="ade-home-stats">
            <span>{workingCount === 1 ? "1 en marcha" : `${workingCount} en marcha`}</span>
            <span className="ade-home-stat-sep" aria-hidden />
            {needsYouCount > 0 ? (
              <button
                type="button"
                className="ade-home-needs-you"
                aria-expanded={decisionsOpen}
                aria-controls="ade-decisions"
                onClick={() => setDecisionsOpen(!decisionsOpen)}
              >
                {needsYouText}
              </button>
            ) : (
              <span>{needsYouText}</span>
            )}
          </p>
        </header>
        <Overnight needsYouCount={needsYouCount} />

        {selected === null ? (
          <p className="ade-home-empty" role="status">
            {loading
              ? "Cargando proyectos…"
              : "No hay proyectos en las máquinas conectadas. Añade un proyecto en T3 Code para empezar un hilo."}
          </p>
        ) : (
          <>
            <NewThreadComposer
              environmentId={selected.environmentId}
              machineLabel={selected.machineLabel}
              project={selected.project}
              onEngage={() => {
                if (selectedKey === null) setSelectedKey(selected.key);
              }}
              onThreadCreated={openThread}
            />
            <ToggleGroup
              value={[selected.key]}
              deselectable={false}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) setSelectedKey(next);
              }}
              aria-label="Proyecto donde empezar el hilo"
              className="ade-home-projects"
            >
              {projects.map((target) => (
                <Toggle
                  key={target.key}
                  value={target.key}
                  className="ade-home-project-chip"
                  aria-label={
                    multipleMachines
                      ? `${target.project.title} · ${target.machineLabel}`
                      : target.project.title
                  }
                >
                  <span
                    className="ade-home-project-mark"
                    style={
                      { "--ade-project-color": projectAccentColor(target.key) } as Record<
                        string,
                        string
                      >
                    }
                    aria-hidden
                  >
                    {projectMonogram(target.project.title)}
                  </span>
                  <span className="ade-home-project-name">{target.project.title}</span>
                  {multipleMachines ? (
                    <span className="ade-home-project-machine">{target.machineLabel}</span>
                  ) : null}
                </Toggle>
              ))}
            </ToggleGroup>
          </>
        )}
      </div>
    </section>
  );
}
