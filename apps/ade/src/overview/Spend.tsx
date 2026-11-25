import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, UsageProviderKind } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { useContext, useEffect, useMemo, useState } from "react";

import { environmentThreadDetails, serverEnvironment } from "../state.ts";
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
const REFRESH_MS = 60_000;

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
  const unpriced = `${formatTokens(line.unpricedTokens)} tok sin precio`;
  if (line.kind === "unpriced") return <span>{unpriced}</span>;
  if (line.kind === "flat") {
    return (
      <span>
        {formatTokens(line.tokens)} tok
        {props.limitShare === undefined ? null : ` · ${percent(props.limitShare)} del límite`}
      </span>
    );
  }
  return (
    <span>
      {usd(line.costUsd)}
      {line.kind === "estimated" ? <span className="ade-spend-est"> est.</span> : null}
      {line.kind === "mixed" ? <span className="ade-spend-est"> incluye est.</span> : null}
      {line.unpricedTokens > 0 ? ` + ${unpriced}` : null}
    </span>
  );
}

const LINE_LABEL = {
  real: "reportado",
  mixed: "reportado y a tarifa",
  estimated: "a tarifa",
  flat: "suscripción",
} as const;

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
  const { window, usage } = useWeekUsage();
  const flat = useAtomValue(flatProvidersAtom);
  const spend = useMemo(
    () => spendSummary(usage.environments, flat.byEnvironment),
    [usage.environments, flat],
  );
  const registry = useContext(RegistryContext);
  const [, setTick] = useState(0);
  const readable = usage.readable.join(",");
  // Reads usage again each minute while the page is visible; a new day moves the window.
  useEffect(() => {
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const environmentId of readable === "" ? [] : readable.split(",")) {
        registry.refresh(
          serverEnvironment.usageSummary({
            environmentId: environmentId as EnvironmentId,
            input: window,
          }),
        );
      }
      setTick((tick) => tick + 1);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [registry, readable, window]);
  const missing = [...usage.needsPairing, ...usage.failed];
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
          {usage.failed.length > 0
            ? `No se pudo leer el uso de ${usage.failed.join(", ")}.`
            : usage.needsPairing.length > 0
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
      <p className="ade-summary-caption">esta semana · hoy {usd(spend.today.realUsd)}</p>
      {spend.week.mixedUsd > 0 ? (
        <p className="ade-summary-caption">
          {usd(spend.week.mixedUsd)} de esa cifra{" "}
          <span className="ade-spend-est">incluye est.</span> a tarifa
        </p>
      ) : null}
      {spend.week.estimatedUsd > 0 ? (
        <p className="ade-summary-caption">
          + {usd(spend.week.estimatedUsd)} <span className="ade-spend-est">est.</span> a tarifa, sin
          factura · fuera del tope
        </p>
      ) : null}
      {hasCap ? <Ruler valueUsd={week} capUsd={cap} /> : null}
      <ul className="ade-summary-rows">
        {spend.week.lines.slice(0, SHOWN_LINES).map((line) => (
          <li key={`${line.provider}:${line.model}:${line.kind}`}>
            <span className="ade-summary-name">{line.model}</span>
            <span className="ade-summary-aside" data-kind={line.kind}>
              {line.kind === "unpriced" ? line.provider : LINE_LABEL[line.kind]}
              <LineAmount line={line} limitShare={flat.peaks.get(line.provider)} />
            </span>
          </li>
        ))}
      </ul>
      {missing.length > 0 ? (
        <p className="ade-summary-caption" data-level="high">
          Total parcial: no está todo el uso de {missing.join(", ")}.
        </p>
      ) : null}
      {usage.failed.length > 0 ? (
        <p className="ade-summary-caption">No se pudo leer el uso de {usage.failed.join(", ")}.</p>
      ) : null}
      {usage.needsPairing.length > 0 ? (
        <p className="ade-summary-caption">
          {usage.needsPairing.join(", ")}: vuelve a emparejar la máquina para ver el gasto.
        </p>
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
 * A bot's estimate for today: its turns' tokens times the week's list price of its provider's
 * model. Mount it only where the thread is already followed: it never opens one for the spend.
 */
export function BotSpend(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  model: string;
  provider: UsageProviderKind | null;
}) {
  const { window, usage } = useWeekUsage();
  const rates = useMemo(() => ratesByModel(usage.environments), [usage.environments]);
  // Without usage (no permission, nothing read) the thread is not even looked at.
  if (usage.environments.length === 0) return null;
  return (
    <BotSpendFigure {...props} day={window.untilDay} timeZone={window.timeZone} rates={rates} />
  );
}

function BotSpendFigure(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  model: string;
  provider: UsageProviderKind | null;
  day: string;
  timeZone: string;
  rates: ReadonlyMap<string, number>;
}) {
  const thread = useAtomValue(
    environmentThreadDetails.quietThreadAtom(scopeThreadRef(props.environmentId, props.threadId)),
  );
  if (thread === null) return null;
  const estimate = botEstimate({
    turns: thread.projection.providerTurns.map((turn) => ({
      model: turn.model,
      endedAtMs: turn.completedAt === null ? null : DateTime.toEpochMillis(turn.completedAt),
      turnTokenUsage: turn.turnTokenUsage,
    })),
    fallbackModel: props.model,
    provider: props.provider,
    day: props.day,
    timeZone: props.timeZone,
    rates: props.rates,
  });
  if (estimate === null) return null;
  const unpriced =
    estimate.unpricedTokens > 0 ? `${formatTokens(estimate.unpricedTokens)} tok sin precio` : null;
  return (
    <span className="ade-bot-spend">
      {estimate.usd > 0 || unpriced === null ? (
        <>
          ~{usd(estimate.usd)} <span className="ade-spend-est">est.</span> hoy
          {unpriced === null ? null : ` + ${unpriced}`}
        </>
      ) : (
        `${unpriced} hoy`
      )}
    </span>
  );
}
