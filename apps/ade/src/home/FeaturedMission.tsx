import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import type { EnvironmentId, ForkBot, WorkflowRunDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { allBotsAtom } from "../bots/bots.state.ts";
import { missionCards, missionState } from "../missions/mission.logic.ts";
import { activeMissionsAtom, openQuestions, useOpenMission } from "../missions/missions.state.ts";
import { viewAtom } from "../overview/Overview.tsx";

const NAMES = new Intl.ListFormat("es-ES", { style: "long", type: "conjunction" });

/** The bots on a run's steps, once each in the order they joined, and its cards done of all. */
export function missionSummary(
  detail: WorkflowRunDetail | undefined,
  bots: ReadonlyArray<ForkBot>,
) {
  if (detail === undefined) return { crew: [], done: 0, total: 0 };
  const cards = missionCards({
    detail,
    questions: [],
    bots,
    threadNeedsYou: () => false,
    now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
  const crew = [
    ...new Map(cards.flatMap((card) => (card.bot ? [[card.bot.id, card.bot]] : []))).values(),
  ];
  return {
    crew,
    done: cards.filter((card) => card.column === "done").length,
    total: cards.length,
  };
}

export function useBotsOf() {
  const { byEnv } = useAtomValue(allBotsAtom);
  return (environmentId: EnvironmentId) => byEnv.get(environmentId) ?? [];
}

/** Backroom's mission in focus: the newest run still going, and the way into it. */
export function FeaturedMission() {
  const [featured] = useAtomValue(activeMissionsAtom);
  const botsOf = useBotsOf();
  const openMission = useOpenMission();
  const setView = useAtomSet(viewAtom);
  if (featured === undefined) {
    return (
      <div className="v2-focus-card">
        <h2 className="v2-h4">Ninguna misión en marcha</h2>
        <p>
          Cuando un flujo arranque, aquí verás su misión: quién lleva cada paso y qué te espera.
        </p>
        <div className="v2-focus-bottom">
          <span />
          <button type="button" onClick={() => setView("misiones")}>
            Ver misiones
            <ArrowRightIcon size={13} aria-hidden />
          </button>
        </div>
      </div>
    );
  }
  const { environmentId, node, detail } = featured;
  const { run } = node;
  const state = missionState(run, openQuestions(node));
  const { crew, done, total } = missionSummary(detail, botsOf(environmentId));
  return (
    <div className="v2-focus-card">
      <h2 className="v2-h4">{run.title || run.workflow}</h2>
      <p>
        {state.word}
        {total === 0 ? "" : ` · ${done} de ${total} pasos hechos`}
        {` · ${run.subject?.title ? run.subject.title : `flujo ${run.workflow}`}`}
      </p>
      <div className="v2-focus-bottom">
        <span className="v2-team-stack">
          {crew.map((bot) => (
            <AgentAvatar key={bot.id} kind={botMascot(bot)} />
          ))}
          {crew.length === 0 ? null : <span>{NAMES.format(crew.map((bot) => bot.name))}</span>}
        </span>
        <button type="button" onClick={() => openMission(environmentId, run.runId)}>
          Ver misión
          <ArrowRightIcon size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}
