import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { NewThreadComposer } from "../composer/Composer.tsx";
import { searchOpenAtom } from "../search/SearchButton.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import {
  listedThreadsAtom,
  selectedThreadKeyAtom,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { environmentProjects, threadEnvironment } from "../state.ts";
import { allBotsAtom } from "../bots/bots.state.ts";
import { FeaturedMission } from "./FeaturedMission.tsx";
import { ForYou, HomeActivity } from "./ForYou.tsx";
import { HomeRail } from "./HomeRail.tsx";
import { ReviewToast } from "./ReviewToast.tsx";
import { forYouSentence, homeChips, homeProjects } from "./home.logic.ts";

export const homeProjectsAtom = Atom.make((get) => {
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

// Kept in memory only so leaving Inicio and returning remembers the picked project without touching localStorage.
export const selectedHomeProjectKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-home-selected-project"),
);

const DATE = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" });
const HOUR = new Intl.DateTimeFormat("es-ES", { hour: "numeric", hourCycle: "h23" });
const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
const todayLabel = () => {
  const text = DATE.format(nowMillis());
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const greeting = () => {
  const hour = Number(HOUR.format(nowMillis()));
  if (hour >= 6 && hour < 13) return "Buenos días";
  return hour >= 6 && hour < 21 ? "Buenas tardes" : "Buenas noches";
};

export function Home() {
  const { projects, machineCount, loading } = useAtomValue(homeProjectsAtom);
  const { count: needsYouCount } = useDecisionsPanel();
  const [selectedKey, setSelectedKey] = useAtom(selectedHomeProjectKeyAtom);
  const openThread = useAtomSet(selectedThreadKeyAtom);
  const openSearch = useAtomSet(searchOpenAtom);

  const selected =
    (selectedKey === null ? undefined : projects.find((target) => target.key === selectedKey)) ??
    projects[0] ??
    null;
  const chips = homeChips(projects, selected);
  const bots = [...useAtomValue(allBotsAtom).byEnv.values()].flat().filter((bot) => !bot.archived);
  const coordinators = bots.filter((bot) => bot.coordinator);
  const coordinator =
    coordinators.find((bot) => bot.projectId === selected?.project.id) ?? coordinators[0] ?? null;
  const team = bots.filter(
    (bot) => coordinator !== null && bot.projectId === coordinator.projectId,
  );
  const multipleMachines = machineCount > 1;

  return (
    <section className="ade-home br" aria-label="Inicio">
      <ReviewToast />
      <div className="v2-app">
        <div className="v2-app-main">
          <header className="v2-app-greeting">
            <span>{todayLabel()}</span>
            <h1 className="v2-h3">{greeting()}</h1>
            <p data-pending={needsYouCount > 0 || undefined}>{forYouSentence(needsYouCount)}</p>
          </header>
          <FeaturedMission />
          <div className="v2-focus-card br-compose">
            <h2 className="v2-h4">¿En qué trabajamos?</h2>
            {selected === null ? (
              <p role="status">
                {loading
                  ? "Cargando proyectos…"
                  : "No hay proyectos en las máquinas conectadas. Añade un proyecto en T3 Code para empezar un hilo."}
              </p>
            ) : (
              <>
                <ToggleGroup
                  value={[selected.key]}
                  deselectable={false}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next !== undefined) setSelectedKey(next);
                  }}
                  aria-label="Proyecto donde empezar el hilo"
                  className="br-projects"
                >
                  {chips.map((target) => (
                    <Toggle
                      key={target.key}
                      value={target.key}
                      className="v4-chip br-project"
                      aria-label={
                        multipleMachines
                          ? `${target.project.title} · ${target.machineLabel}`
                          : target.project.title
                      }
                    >
                      {target.project.title}
                      {multipleMachines ? <small>{target.machineLabel}</small> : null}
                    </Toggle>
                  ))}
                  {projects.length > chips.length ? (
                    <button
                      type="button"
                      className="v4-chip br-project"
                      aria-haspopup="dialog"
                      onClick={() => openSearch("proyectos")}
                    >
                      Más…
                    </button>
                  ) : null}
                </ToggleGroup>
                <NewThreadComposer
                  environmentId={selected.environmentId}
                  machineLabel={selected.machineLabel}
                  project={selected.project}
                  onEngage={() => {
                    if (selectedKey === null) setSelectedKey(selected.key);
                  }}
                  onThreadCreated={openThread}
                />
              </>
            )}
          </div>
          <ForYou onOpenThread={openThread} />
          <HomeActivity multipleMachines={multipleMachines} />
        </div>
        <HomeRail coordinator={coordinator} team={team} needsYouCount={needsYouCount} />
      </div>
    </section>
  );
}
