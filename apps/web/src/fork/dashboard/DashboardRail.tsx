// Fork-only: the Dashboard as a right panel surface beside a chat, the same sections in one column.
import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { DashboardMachines } from "./DashboardMachines";
import { DashboardSubscriptions } from "./DashboardSubscriptions";
import { DashboardThreads } from "./DashboardThreads";
import { type DashboardPanelId, resolvePanels } from "./dashboardLayout.logic";
import { useSavedDashboardLayout } from "./dashboardLayoutState";

function Section(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="font-serif text-xl tracking-tight">{props.title}</h2>
        {props.action ? <span className="ms-auto flex">{props.action}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function OpenFullDashboard() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open the full dashboard"
            render={<Link to="/dashboard" />}
          />
        }
      >
        <Maximize2Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Open the full dashboard</TooltipPopup>
    </Tooltip>
  );
}

/** Nothing renders while the panel is hidden, so its sections stop polling with it. */
export function DashboardRail({ visible }: { readonly visible: boolean }) {
  return visible ? <DashboardRailContent /> : null;
}

function DashboardRailContent() {
  // The minute tick is UTC without a zone suffix; it refreshes reset and relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const layout = useSavedDashboardLayout();
  const panels = resolvePanels(layout).filter((panel) => !panel.hidden);
  const body = (id: DashboardPanelId) => {
    switch (id) {
      case "machines":
        return <DashboardMachines nowMs={nowMs} layout={layout} compact />;
      case "subscriptions":
        return <DashboardSubscriptions nowMs={nowMs} layout={layout} compact />;
      case "threads":
        return <DashboardThreads nowMs={nowMs} compact />;
    }
  };
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="flex flex-col gap-6 px-3 pt-3 pb-6">
        {panels.length === 0 ? (
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">Every section is hidden.</p>
            <span className="ms-auto flex">
              <OpenFullDashboard />
            </span>
          </div>
        ) : null}
        {panels.map((panel, index) => (
          <Section
            key={panel.id}
            title={panel.title}
            action={index === 0 ? <OpenFullDashboard /> : undefined}
          >
            {body(panel.id)}
          </Section>
        ))}
      </div>
    </div>
  );
}
