import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import type { ForkBot } from "@t3tools/contracts";
import { useState } from "react";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { WorkTile } from "../backroom/WorkTile.tsx";
import { missionDeliverables, missionState } from "../missions/mission.logic.ts";
import {
  activeMissionsAtom,
  missionRowsAtom,
  openQuestions,
  useOpenMission,
} from "../missions/missions.state.ts";
import { viewAtom } from "../overview/Overview.tsx";
import { missionSummary, useBotsOf } from "./FeaturedMission.tsx";
import { activityAtom, useActivityRow } from "./ForYou.tsx";
import { Overnight } from "./Overnight.tsx";

const NAMES = new Intl.ListFormat("es-ES", { style: "long", type: "conjunction" });
const RAIL_MISSIONS = 6;

function Face(props: { bot: ForkBot | undefined }) {
  return props.bot === undefined ? (
    <span className="agent-avatar br-face" aria-hidden>
      <FlowArrowIcon size={14} />
    </span>
  ) : (
    <AgentAvatar kind={botMascot(props.bot)} />
  );
}

/** The right rail: who coordinates and what is on the table, or the missions, at a switch. */
export function HomeRail(props: {
  coordinator: ForkBot | null;
  team: ReadonlyArray<ForkBot>;
  needsYouCount: number;
}) {
  const [tab, setTab] = useState<"coordination" | "missions">("coordination");
  return (
    <aside className="v2-app-rail" aria-label="Coordinación">
      <div className="v2-rail-piece">
        <div className="v2-rail-switch" role="group" aria-label="Qué enseña el riel">
          <button
            type="button"
            aria-pressed={tab === "coordination"}
            onClick={() => setTab("coordination")}
          >
            Coordinación
          </button>
          <button
            type="button"
            aria-pressed={tab === "missions"}
            onClick={() => setTab("missions")}
          >
            Misiones
          </button>
        </div>
        {tab === "coordination" ? <Coordination {...props} /> : <RailMissions />}
      </div>
    </aside>
  );
}

function Coordination(props: {
  coordinator: ForkBot | null;
  team: ReadonlyArray<ForkBot>;
  needsYouCount: number;
}) {
  const active = useAtomValue(activeMissionsAtom);
  const { finished } = useAtomValue(activityAtom);
  const botsOf = useBotsOf();
  const openMission = useOpenMission();
  const setView = useAtomSet(viewAtom);
  const row = useActivityRow(false);
  const { coordinator } = props;
  const deliverables = active.flatMap(({ detail }) =>
    missionDeliverables(detail?.references ?? []),
  );
  const newest = deliverables.at(-1);
  const others = props.team.filter((bot) => bot.id !== coordinator?.id);
  return (
    <>
      <div className="v2-rail-card">
        {coordinator === null ? null : (
          <div className="v2-rail-profile">
            <AgentAvatar kind="orbit" />
            <div className="v2-h4">{coordinator.name}</div>
            <p>Coordinación</p>
            <small>
              <i />
              {coordinator.role}
            </small>
          </div>
        )}
        <div className="v2-rail-stats">
          <span>
            <strong>{active.length}</strong>
            Misiones
          </span>
          <span>
            <strong>{deliverables.length}</strong>
            Entregables
          </span>
        </div>
      </div>
      <div className="v2-rail-block">
        <div className="v2-h5">
          Sobre la mesa
          <button type="button" aria-label="Ver las misiones" onClick={() => setView("misiones")}>
            <ArrowRightIcon size={13} aria-hidden />
          </button>
        </div>
        {active.length === 0 ? (
          <p className="br-empty br-rail-empty">Nada en marcha ahora.</p>
        ) : (
          active.slice(0, 3).map(({ environmentId, node, detail }) => {
            const state = missionState(node.run, openQuestions(node));
            return (
              <button
                key={`${environmentId}:${node.run.runId}`}
                type="button"
                onClick={() => openMission(environmentId, node.run.runId)}
              >
                <Face bot={missionSummary(detail, botsOf(environmentId)).crew[0]} />
                <span>
                  {node.run.title || node.run.workflow}
                  <small data-state={state.tone === "you" ? "review" : "progress"}>
                    {state.word}
                  </small>
                </span>
              </button>
            );
          })
        )}
      </div>
      {finished.length === 0 ? null : (
        <div className="v2-rail-block">
          <div className="v2-h5">Lo último terminado</div>
          <ul className="br-rail-list">{finished.map((thread) => row(thread, true))}</ul>
        </div>
      )}
      <div className="v2-rail-block">
        <div className="v2-h5">A mano</div>
        <div className="v2-rail-tools">
          {newest === undefined || newest.url === null ? (
            <button type="button" onClick={() => setView("misiones")}>
              <WorkTile kind="check" size="sm" />
              Misiones
            </button>
          ) : (
            <a href={newest.url} target="_blank" rel="noreferrer" aria-label={newest.title}>
              <WorkTile kind="doc" size="sm" />
              {newest.where ?? newest.label}
            </a>
          )}
          <button type="button" onClick={() => setView("memoria")}>
            <WorkTile kind="book" size="sm" />
            Memoria
          </button>
        </div>
      </div>
      {coordinator === null || others.length === 0 ? null : (
        <div className="v2-rail-note">
          <ChatCircleIcon size={16} aria-hidden />
          <p>
            {coordinator.name} coordina a {NAMES.format(others.map((bot) => bot.name))} para que el
            trabajo avance contigo.
          </p>
        </div>
      )}
      <Overnight needsYouCount={props.needsYouCount} />
    </>
  );
}

function RailMissions() {
  const { rows } = useAtomValue(missionRowsAtom);
  const openMission = useOpenMission();
  const setView = useAtomSet(viewAtom);
  return (
    <div className="v2-rail-block">
      <div className="v2-h5">
        Misiones
        <button type="button" aria-label="Ver todas" onClick={() => setView("misiones")}>
          <ArrowRightIcon size={13} aria-hidden />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="br-empty br-rail-empty">Aún no hay misiones.</p>
      ) : (
        rows.slice(0, RAIL_MISSIONS).map(({ environmentId, node }) => {
          const state = missionState(node.run, openQuestions(node));
          return (
            <button
              key={`${environmentId}:${node.run.runId}`}
              type="button"
              onClick={() => openMission(environmentId, node.run.runId)}
            >
              <WorkTile kind="check" size="sm" />
              <span>
                {node.run.title || node.run.workflow}
                <small data-state={state.tone === "you" ? "review" : "progress"}>
                  {state.word}
                </small>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
