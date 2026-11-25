import { useAtomValue } from "@effect/atom-react";
import { ArrowDownRightIcon } from "@phosphor-icons/react/dist/csr/ArrowDownRight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  formatCount,
  formatDayShort,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { useMemo, useState } from "react";

import { ProviderIcon } from "../composer/ProviderIcon.tsx";
import {
  type GastoRow,
  type SpendRange,
  gasto,
  trend,
  usageDriver,
  windowDays,
} from "./gasto.logic.ts";
import { WidenUsage } from "./Spend.tsx";
import { flatProvidersAtom, spendUsageAtom } from "./spend.state.ts";

const RANGES: ReadonlyArray<{ value: SpendRange; label: string }> = [
  { value: "7d", label: "7 días" },
  { value: "1m", label: "1 mes" },
  { value: "6m", label: "6 meses" },
  { value: "1y", label: "1 año" },
  { value: "all", label: "Todo" },
];

const UNIT_LABEL = { day: "día", week: "semana", month: "mes" } as const;

const usd = (value: number) => formatUsd(value, "es-ES");
const count = (value: number) => formatCount(value, "es-ES");
const day = (value: string) => formatDayShort(value, "es-ES");
const monthFormat = new Intl.DateTimeFormat("es-ES", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

const binLabel = (key: string, unit: keyof typeof UNIT_LABEL) =>
  unit === "month" ? monthFormat.format(Date.parse(`${key}-01T00:00:00Z`)) : day(key);

const usageKey = (days: number) => JSON.stringify(makeWindow(days));

function ProviderMark(props: { provider: UsageProviderKind }) {
  const driver = usageDriver(props.provider);
  return (
    <ProviderIcon
      provider={{
        driver,
        instanceId: defaultInstanceIdForDriver(driver),
        label: PROVIDER_DISPLAY_NAMES[driver] ?? props.provider,
        accentColor: undefined,
      }}
    />
  );
}

function Trend(props: { current: number; previous: number | null }) {
  const change = trend(props.current, props.previous);
  if (change === null) return <span className="ade-gasto-trend">sin datos previos</span>;
  if (Math.round(change * 100) === 0) {
    return <span className="ade-gasto-trend">sin cambios vs. periodo anterior</span>;
  }
  const Arrow = change >= 0 ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span className="ade-gasto-trend">
      <Arrow size={13} aria-hidden />
      {`${change >= 0 ? "+" : "−"}${Math.round(Math.abs(change) * 100)} %`}
      <span className="ade-gasto-trend-vs"> vs. periodo anterior</span>
    </span>
  );
}

/** A figure, `null` when unknown, against the same figure of the period before. */
function Stat(props: {
  label: string;
  current: number | null;
  previous: number | null;
  format: (value: number) => string;
  /** What the figure reads when it is unknown. */
  missing?: string;
  /** «Todo»: no period before, only where the usage read starts. */
  since: string | null;
  notes?: ReadonlyArray<string>;
}) {
  return (
    <section className="ade-gasto-stat">
      <h2 className="ade-label">{props.label}</h2>
      <p className="ade-gasto-figure">
        {props.current === null ? (props.missing ?? "Sin datos") : props.format(props.current)}
      </p>
      {props.current === null ? null : props.since !== null ? (
        <span className="ade-gasto-trend">desde {day(props.since)}</span>
      ) : (
        <Trend current={props.current} previous={props.previous} />
      )}
      {props.notes?.map((note) => (
        <p key={note} className="ade-gasto-note">
          {note}
        </p>
      ))}
    </section>
  );
}

function CostCell(props: { row: GastoRow; perRequest?: boolean }) {
  const { row } = props;
  if (row.kind === "flat") return <>suscripción</>;
  if (row.kind === "unpriced") return <>sin precio</>;
  if (props.perRequest && row.requests === 0) return <>sin datos</>;
  const value = props.perRequest ? row.costUsd / row.requests : row.costUsd;
  return (
    <>
      {usd(value)}
      {row.kind === "estimated" ? <span className="ade-spend-est"> est.</span> : null}
      {row.kind === "mixed" ? <span className="ade-spend-est"> incluye est.</span> : null}
    </>
  );
}

const orNull = (value: number) => (value > 0 ? value : null);

export function GastoView() {
  const [range, setRange] = useState<SpendRange>("7d");
  // The window only grows: a shorter range reuses what was read, a longer one reads once more.
  const [wantDays, setWantDays] = useState(windowDays("7d"));
  // What the screen shows: kept while a longer window is read, so nothing empties meanwhile.
  const [shown, setShown] = useState({ range, days: wantDays });
  const wanted = useAtomValue(spendUsageAtom(usageKey(wantDays)));
  if (shown.range !== range && windowDays(range) <= shown.days) {
    setShown({ range, days: shown.days });
  } else if (shown.days < wantDays && !wanted.pending) {
    setShown({ range, days: wantDays });
  }
  const shownWindow = makeWindow(shown.days);
  const usage = useAtomValue(spendUsageAtom(usageKey(shown.days)));
  const flat = useAtomValue(flatProvidersAtom);
  const data = useMemo(
    () => gasto(usage.environments, flat.byEnvironment, shown.range, shownWindow.untilDay),
    [usage.environments, flat, shown.range, shownWindow.untilDay],
  );
  const { current, previous } = data;
  const since = shown.range === "all" ? data.firstDay : null;
  const perRequest = (totals: typeof current) =>
    totals.requests === 0 ? null : totals.tokens / totals.requests;
  const maxTokens = Math.max(0, ...data.bins.map((bin) => bin.tokens));
  const missing = [...usage.needsPairing.map((machine) => machine.label), ...usage.failed];
  const readingMore = shown.days < wantDays;
  const empty = data.rows.length === 0;
  const lastBin = data.bins.at(-1);

  return (
    <section className="ade-gasto" aria-label="Gasto">
      <header className="ade-gasto-head">
        <h1>Gasto</h1>
        <ToggleGroup
          value={[range]}
          deselectable={false}
          onValueChange={(values) => {
            const next = RANGES.find((option) => option.value === values[0]);
            if (next === undefined) return;
            setRange(next.value);
            setWantDays((days) => Math.max(days, windowDays(next.value)));
          }}
          aria-label="Periodo"
          className="ade-gasto-ranges"
        >
          {RANGES.map((option) => (
            <Toggle key={option.value} value={option.value} className="ade-gasto-range">
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </header>

      {readingMore ? (
        <p className="ade-gasto-note" role="status">
          Leyendo {RANGES.find((option) => option.value === range)?.label.toLowerCase()}…
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="ade-gasto-note" data-level="high">
          Total parcial: no está todo el uso de {missing.join(", ")}.
        </p>
      ) : usage.pending && !empty ? (
        <p className="ade-gasto-note" data-level="high">
          Total parcial: aún se lee el uso de alguna máquina.
        </p>
      ) : null}
      {usage.needsPairing.map((machine) => (
        <WidenUsage key={machine.environmentId} {...machine} />
      ))}

      {empty ? (
        <p className="ade-gasto-empty" role="status">
          {usage.pending ? "Leyendo el uso de las máquinas…" : "Sin datos de uso en este periodo."}
        </p>
      ) : (
        <>
          <div className="ade-gasto-stats">
            <Stat
              label="Tokens"
              current={orNull(current.tokens)}
              previous={previous?.tokens ?? null}
              format={formatTokens}
              since={since}
            />
            <Stat
              label="Coste"
              current={current.paid ? current.costUsd : null}
              previous={previous?.paid ? previous.costUsd : null}
              format={usd}
              missing={current.flat ? "Incluido en suscripciones" : "Sin API de pago"}
              since={since}
              notes={[
                ...(current.mixedUsd > 0
                  ? [`${usd(current.mixedUsd)} de esa cifra incluye est. a tarifa`]
                  : []),
                ...(current.estimatedUsd > 0
                  ? [`+ ${usd(current.estimatedUsd)} est. a tarifa, sin factura`]
                  : []),
              ]}
            />
            <Stat
              label="Peticiones"
              current={orNull(current.requests)}
              previous={previous?.requests ?? null}
              format={count}
              since={since}
            />
            <Stat
              label="Media por petición"
              current={perRequest(current)}
              previous={previous === null ? null : perRequest(previous)}
              format={(value) => `${formatTokens(value)} tok`}
              since={since}
            />
          </div>

          <figure className="ade-gasto-chart">
            <figcaption>
              <span>Tokens por {UNIT_LABEL[data.unit]}</span>
              <span className="ade-gasto-chart-max">máx. {formatTokens(maxTokens)}</span>
            </figcaption>
            <ol className="ade-gasto-bars">
              {data.bins.map((bin, index) => {
                // A week's key is its Monday; the first one may start later, on the range's first day.
                const label =
                  index === 0 && data.unit !== "month"
                    ? day(data.firstDay)
                    : binLabel(bin.key, data.unit);
                const text = `${label}: ${formatTokens(bin.tokens)} tok · ${usd(bin.costUsd)}`;
                return (
                  <li key={bin.key} data-label={text}>
                    <span
                      className="ade-gasto-bar"
                      style={{ height: maxTokens === 0 ? 0 : `${(bin.tokens / maxTokens) * 100}%` }}
                    />
                    <span className="ade-sr-only">{text}</span>
                  </li>
                );
              })}
            </ol>
            {lastBin === undefined ? null : (
              <div className="ade-gasto-axis" aria-hidden>
                <span>
                  {data.unit === "month"
                    ? binLabel(data.bins[0]!.key, "month")
                    : day(data.firstDay)}
                </span>
                {data.bins.length > 1 ? <span>{binLabel(lastBin.key, data.unit)}</span> : null}
              </div>
            )}
          </figure>
          <div className="ade-gasto-table-wrap">
            <table className="ade-gasto-table">
              <thead>
                <tr>
                  <th scope="col">Modelo</th>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Peticiones</th>
                  <th scope="col">Coste</th>
                  <th scope="col">Coste por petición</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={`${row.provider} ${row.model} ${row.account} ${row.kind}`}>
                    <th scope="row">
                      <span className="ade-gasto-model">
                        <ProviderMark provider={row.provider} />
                        {row.model}
                      </span>
                    </th>
                    <td>{row.account}</td>
                    <td>{formatTokens(row.tokens)}</td>
                    <td>{count(row.requests)}</td>
                    <td>
                      <CostCell row={row} />
                    </td>
                    <td>
                      <CostCell row={row} perRequest />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ade-gasto-note">
            Importes en dólares, como los da el servidor. «est.»: tokens a precio de tarifa, sin
            factura. Suscripción: plan con límite, sin coste por uso.
          </p>
        </>
      )}
    </section>
  );
}
