import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { useMemo, useState } from "react";

import { environmentThreadDetails } from "../state.ts";
import {
  botEstimate,
  ratesByModel,
  rulerTicks,
  type SpendLine,
  spendSummary,
  weekWindow,
} from "./spend.logic.ts";
import { flatProvidersAtom, spendUsageAtom } from "./spend.state.ts";

const CAP_KEY = "ade.spend.weeklyCapUsd";
const SHOWN_LINES = 6;

const usd = (value: number) => formatUsd(value, "es-ES");
const percent = (share: number) => `${Math.round(share * 100)} %`;

function readCap(): string {
  try {
    return localStorage.getItem(CAP_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeCap(value: string) {
  try {
    if (value === "") localStorage.removeItem(CAP_KEY);
    else localStorage.setItem(CAP_KEY, value);
  } catch {
    // Private browsing may refuse storage; the cap then lasts for this page.
  }
}

/** The week's usage, read once per day window; every reader of the same window shares it. */
function useWeekUsage() {
  const window = weekWindow();
  return { window, usage: useAtomValue(spendUsageAtom(JSON.stringify(window))) };
}

function LineAmount(props: { line: SpendLine; limitShare: number | undefined }) {
  const { line } = props;
  if (line.kind === "real") return <span>{usd(line.costUsd)}</span>;
  if (line.kind === "unpriced") return <span>sin precio · {formatTokens(line.tokens)} tok</span>;
  return (
    <span>
      {formatTokens(line.tokens)} tok
      {props.limitShare === undefined ? null : ` · ${percent(props.limitShare)} del límite`}
    </span>
  );
}

function Ruler(props: { valueUsd: number; capUsd: number }) {
  return (
    <div className="ade-spend-ruler" aria-hidden>
      <div className="ade-spend-ticks">
        {rulerTicks(props.valueUsd, props.capUsd).map((tick) => (
          <span
            key={tick.at}
            data-filled={tick.filled ? "" : undefined}
            data-major={tick.major ? "" : undefined}
          />
        ))}
      </div>
      <div className="ade-spend-scale">
        <span>{usd(0)}</span>
        <span>{usd(props.capUsd / 2)}</span>
        <span>{usd(props.capUsd)}</span>
      </div>
    </div>
  );
}

export function SpendCard() {
  const { usage } = useWeekUsage();
  const flat = useAtomValue(flatProvidersAtom);
  const spend = useMemo(
    () => spendSummary(usage.environments, new Set(flat.keys())),
    [usage.environments, flat],
  );
  const [capText, setCapText] = useState(readCap);
  const cap = Number(capText);
  const hasCap = capText !== "" && Number.isFinite(cap) && cap > 0;
  const week = spend.week.realUsd;

  if (usage.environments.length === 0) {
    return (
      <section className="ade-summary-card">
        <h2 className="ade-label">Gasto</h2>
        <p className="ade-summary-figure">Sin datos</p>
        <p className="ade-summary-caption">
          {usage.needsPairing.length > 0
            ? "Vuelve a emparejar la máquina para ver el gasto."
            : usage.pending
              ? "Leyendo el uso de las máquinas…"
              : "Las máquinas aún no han informado del uso."}
        </p>
      </section>
    );
  }

  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Gasto</h2>
      <p className="ade-summary-figure" data-level={hasCap && week > cap ? "full" : undefined}>
        {usd(week)}
        {hasCap ? <span className="ade-spend-of"> de {usd(cap)}</span> : null}
      </p>
      <p className="ade-summary-caption">
        pago por uso esta semana · hoy {usd(spend.today.realUsd)}
      </p>
      {hasCap ? <Ruler valueUsd={week} capUsd={cap} /> : null}
      <ul className="ade-summary-rows">
        {spend.week.lines.slice(0, SHOWN_LINES).map((line) => (
          <li key={`${line.provider}:${line.model}`}>
            <span className="ade-summary-name">{line.model}</span>
            <span className="ade-summary-aside" data-kind={line.kind}>
              {line.kind === "flat" ? "suscripción" : line.provider}
              <LineAmount line={line} limitShare={flat.get(line.provider)} />
            </span>
          </li>
        ))}
      </ul>
      {usage.needsPairing.length > 0 ? (
        <p className="ade-summary-caption">
          {usage.needsPairing.join(", ")}: vuelve a emparejar la máquina para ver el gasto.
        </p>
      ) : null}
      {usage.failed.length > 0 ? (
        <p className="ade-summary-caption">{usage.failed.join(", ")}: no se pudo leer el uso.</p>
      ) : null}
      <label className="ade-spend-cap">
        Tope semanal
        <input
          type="number"
          min={0}
          step={1}
          inputMode="decimal"
          placeholder="sin tope"
          value={capText}
          onChange={(event) => {
            setCapText(event.target.value);
            writeCap(event.target.value);
          }}
        />
        US$
      </label>
    </section>
  );
}

/**
 * A bot's estimate for today: its turns' tokens times the week's list price per model. Read
 * only from a thread the ADE already follows, so it adds nothing to the WebSocket.
 */
export function BotSpend(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  model: string;
}) {
  const { window, usage } = useWeekUsage();
  const rates = useMemo(() => ratesByModel(usage.environments), [usage.environments]);
  const thread = useAtomValue(
    environmentThreadDetails.quietThreadAtom(scopeThreadRef(props.environmentId, props.threadId)),
  );
  if (thread === null || usage.environments.length === 0) return null;
  const estimate = botEstimate({
    turns: thread.projection.providerTurns.map((turn) => ({
      model: turn.model,
      endedAtMs: turn.completedAt === null ? null : DateTime.toEpochMillis(turn.completedAt),
      turnTokenUsage: turn.turnTokenUsage,
    })),
    fallbackModel: props.model,
    day: window.untilDay,
    timeZone: window.timeZone,
    rates,
  });
  if (estimate === null) return null;
  const unpriced =
    estimate.unpricedTokens > 0 ? `${formatTokens(estimate.unpricedTokens)} tok sin precio` : null;
  return (
    <span className="ade-bot-spend">
      {estimate.usd > 0 || unpriced === null ? (
        <>
          ~{usd(estimate.usd)} <span className="ade-spend-est">est.</span> hoy
          {unpriced === null ? null : ` · ${unpriced}`}
        </>
      ) : (
        `${unpriced} hoy`
      )}
    </span>
  );
}
