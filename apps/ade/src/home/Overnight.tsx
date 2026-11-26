import { useAtomValue } from "@effect/atom-react";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { formatUsd } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";

import { isNightlyTask } from "../bots/bots.logic.ts";
import { allCoordinationEntriesAtom } from "../coordination/coordination.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { useBotNotices } from "../decisions/BotNotices.tsx";
import { paidFigure } from "../overview/Spend.tsx";
import { spendSummary, weekWindow } from "../overview/spend.logic.ts";
import { flatProvidersAtom, spendUsageAtom } from "../overview/spend.state.ts";
import { serverEnvironment } from "../state.ts";
import { overnightSummary } from "./home.logic.ts";

const nightlyRunsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return [...enabledEnvironmentIds(catalog)].flatMap((environmentId) => {
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const tasks = AsyncResult.getOrElse(result, () => null)?.tasks ?? [];
    return tasks.flatMap((task) =>
      isNightlyTask(task) && task.lastRunAt !== null ? [task.lastRunAt] : [],
    );
  });
}).pipe(Atom.withLabel("ade-nightly-runs"));

const usd = (value: number) => formatUsd(value, "es-ES");

/** What happened overnight, from data the decisions tray, the board and Gasto already read. */
export function Overnight(props: { needsYouCount: number }) {
  const nightlyRuns = useAtomValue(nightlyRunsAtom);
  const { byEnv } = useAtomValue(allCoordinationEntriesAtom);
  const proposals = useBotNotices().filter((notice) => notice.type === "proposal").length;
  const window = weekWindow();
  const usage = useAtomValue(spendUsageAtom(JSON.stringify(window)));
  const flat = useAtomValue(flatProvidersAtom);
  const summary = overnightSummary({
    nightlyRuns,
    entries: [...byEnv.values()].flat(),
    now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
  if (summary === null) return null;
  const week = spendSummary(usage.environments, flat.byEnvironment).week;
  const partial = usage.needsPairing.length > 0 || usage.failed.length > 0 ? " · parcial" : "";
  const spend = usage.pending
    ? "cargando…"
    : // A machine read with no activity shows 0; nothing read at all is no data.
      !usage.environments.some(
          ({ summary }) =>
            summary.buckets.length > 0 || summary.sources.some((source) => source.status === "ok"),
        )
      ? // Only a known missing usage:read is a permission problem; anything else is no data.
        usage.readable.length === 0 && usage.failed.length === 0 && usage.needsPairing.length > 0
        ? "sin permiso para leerlo"
        : "sin datos"
      : `${paidFigure(week)}${week.estimatedUsd > 0 ? ` · ${usd(week.estimatedUsd)} est.` : ""}${partial}`;
  const pending = props.needsYouCount;

  return (
    <section className="v2-rail-note" aria-label="Mientras dormías">
      <MoonIcon size={17} aria-hidden />
      <ul>
        <li>
          {pending === 1 ? "1 decisión pendiente" : `${pending} decisiones pendientes`}
          {proposals === 0 ? null : ` (${proposals} de bot nuevo)`}
        </li>
        <li>
          {summary.closed === 1 ? "1 hueco cerrado" : `${summary.closed} huecos cerrados`} en el
          tablero
        </li>
        <li>Gasto de la semana: {spend}</li>
      </ul>
    </section>
  );
}
