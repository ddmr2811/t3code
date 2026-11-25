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
  const pending = props.needsYouCount;

  return (
    <section className="ade-overnight" aria-label="Mientras dormías">
      <h2>
        <MoonIcon size={15} aria-hidden />
        Mientras dormías
      </h2>
      <ul>
        <li>
          {pending === 1 ? "1 decisión pendiente" : `${pending} decisiones pendientes`}
          {proposals === 0 ? null : ` (${proposals} de bot nuevo)`}
        </li>
        <li>
          {summary.closed === 1 ? "1 hueco cerrado" : `${summary.closed} huecos cerrados`} en el
          tablero
        </li>
        <li>
          {usage.pending
            ? "Gasto de la semana: cargando…"
            : `Gasto de la semana: ${usd(week.realUsd)}${week.estimatedUsd > 0 ? ` · ${usd(week.estimatedUsd)} est.` : ""}`}
        </li>
      </ul>
    </section>
  );
}
