import { useAtomValue } from "@effect/atom-react";
import { ArrowDownRightIcon } from "@phosphor-icons/react/dist/csr/ArrowDownRight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { formatCount, formatDayShort, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { useMemo, useState } from "react";

import { ProviderIcon } from "../composer/ProviderIcon.tsx";
import { type GastoRow, type SpendRange, gasto, rangeWindow, trend } from "./gasto.logic.ts";
import { WidenUsage } from "./Spend.tsx";
import { flatProvidersAtom, spendUsageAtom, USAGE_PROVIDER_OF_DRIVER } from "./spend.state.ts";

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
const monthFormat = new Intl.DateTimeFormat("es-ES", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

const binLabel = (key: string, unit: keyof typeof UNIT_LABEL) =>
  unit === "month"
    ? monthFormat.format(Date.parse(`${key}-01T00:00:00Z`))
    : formatDayShort(key, "es-ES");

const DRIVER_OF_USAGE = Object.fromEntries(
  Object.entries(USAGE_PROVIDER_OF_DRIVER).map(([driver, provider]) => [provider, driver]),
) as Record<UsageProviderKind, string>;

function ProviderMark(props: { provider: UsageProviderKind }) {
  const driver = ProviderDriverKind.make(DRIVER_OF_USAGE[props.provider] ?? props.provider);
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

function Trend(props: { current: number; previous: number | null; all: boolean }) {
  if (props.all) return <span className="ade-gasto-trend">todo el historial</span>;
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

function Stat(props: {
  label: string;
  value: string;
  current: number;
  previous: number | null;
  all: boolean;
  note?: string | undefined;
}) {
  return (
    <section className="ade-gasto-stat">
      <h2 className="ade-label">{props.label}</h2>
      <p className="ade-gasto-figure">{props.value}</p>
      <Trend current={props.current} previous={props.previous} all={props.all} />
      {props.note === undefined ? null : <p className="ade-gasto-note">{props.note}</p>}
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

export function GastoView() {
  const [range, setRange] = useState<SpendRange>("7d");
  const window = rangeWindow(range);
  const usage = useAtomValue(spendUsageAtom(JSON.stringify(window)));
  const flat = useAtomValue(flatProvidersAtom);
  const data = useMemo(
    () => gasto(usage.environments, flat.byEnvironment, range, window.untilDay),
    [usage.environments, flat, range, window.untilDay],
  );
  const all = range === "all";
  const { current, previous } = data;
  const perRequest = (totals: typeof current) =>
    totals.requests === 0 ? 0 : totals.tokens / totals.requests;
  const maxTokens = Math.max(0, ...data.bins.map((bin) => bin.tokens));
  const missing = [...usage.needsPairing.map((machine) => machine.label), ...usage.failed];
  const empty = data.rows.length === 0;

  return (
    <section className="ade-gasto" aria-label="Gasto">
      <header className="ade-gasto-head">
        <h1>Gasto</h1>
        <ToggleGroup
          value={[range]}
          deselectable={false}
          onValueChange={(values) => {
            const next = RANGES.find((option) => option.value === values[0]);
            if (next !== undefined) setRange(next.value);
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

      {missing.length > 0 ? (
        <p className="ade-gasto-note" data-level="high">
          Total parcial: no está todo el uso de {missing.join(", ")}.
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
              value={current.tokens === 0 ? "Sin datos" : formatTokens(current.tokens)}
              current={current.tokens}
              previous={previous?.tokens ?? null}
              all={all}
            />
            <Stat
              label="Coste"
              value={current.priced ? usd(current.costUsd) : "Sin datos"}
              current={current.costUsd}
              previous={previous?.priced ? previous.costUsd : null}
              all={all}
              note={
                current.estimatedUsd > 0
                  ? `incluye ${usd(current.estimatedUsd)} est. a tarifa`
                  : undefined
              }
            />
            <Stat
              label="Peticiones"
              value={current.requests === 0 ? "Sin datos" : count(current.requests)}
              current={current.requests}
              previous={previous?.requests ?? null}
              all={all}
            />
            <Stat
              label="Media por petición"
              value={
                current.requests === 0 ? "Sin datos" : `${formatTokens(perRequest(current))} tok`
              }
              current={perRequest(current)}
              previous={previous === null ? null : perRequest(previous)}
              all={all}
            />
          </div>

          <figure className="ade-gasto-chart">
            <figcaption>
              <span>Tokens por {UNIT_LABEL[data.unit]}</span>
              <span className="ade-gasto-chart-max">máx. {formatTokens(maxTokens)}</span>
            </figcaption>
            <ol className="ade-gasto-bars">
              {data.bins.map((bin) => (
                <li key={bin.key}>
                  <span
                    className="ade-gasto-bar"
                    style={{ height: maxTokens === 0 ? 0 : `${(bin.tokens / maxTokens) * 100}%` }}
                  />
                  <span className="ade-sr-only">
                    {binLabel(bin.key, data.unit)}: {formatTokens(bin.tokens)} tokens
                  </span>
                </li>
              ))}
            </ol>
            {data.bins.length > 0 ? (
              <div className="ade-gasto-axis" aria-hidden>
                <span>{binLabel(data.bins[0]!.key, data.unit)}</span>
                <span>{binLabel(data.bins.at(-1)!.key, data.unit)}</span>
              </div>
            ) : null}
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
