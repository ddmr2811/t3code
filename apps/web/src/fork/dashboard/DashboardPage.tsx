// Fork-only: one page with every machine, the tailnet, the subscriptions and the active threads,
// arranged as saved in the primary server's settings and editable in place.
import type { ForkDashboardLayout } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, PencilIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import { SidebarInset } from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { DashboardMachines, useDashboardMachineData } from "./DashboardMachines";
import { DashboardSubscriptions } from "./DashboardSubscriptions";
import { DashboardThreads } from "./DashboardThreads";
import {
  consolidateLayout,
  type DashboardPanelId,
  isDefaultLayout,
  movePanel,
  resetLayout,
  type ResolvedPanel,
  resolvePanels,
  setPanelHidden,
} from "./dashboardLayout.logic";
import { useDashboardLayoutWriter, useSavedDashboardLayout } from "./dashboardLayoutState";

function Section(props: {
  readonly panel: ResolvedPanel;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.panel.title} className="flex flex-col gap-4">
      <div className="flex min-h-9 items-center gap-3">
        <h2
          className={cn(
            "font-serif text-3xl tracking-tight",
            props.panel.hidden && "text-muted-foreground",
          )}
        >
          {props.panel.title}
        </h2>
        {props.controls}
      </div>
      {props.children}
    </section>
  );
}

function PanelControls(props: {
  readonly panel: ResolvedPanel;
  readonly index: number;
  readonly count: number;
  readonly onHidden: (hidden: boolean) => void;
  readonly onMove: (steps: number) => void;
}) {
  const { panel } = props;
  return (
    <span className="ms-auto flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-pressed={panel.hidden}
        onClick={() => props.onHidden(!panel.hidden)}
      >
        {panel.hidden ? <EyeOffIcon /> : <EyeIcon />}
        {panel.hidden ? "Hidden" : "Shown"}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        disabled={props.index === 0}
        aria-label={`Move ${panel.title} up`}
        onClick={() => props.onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        disabled={props.index === props.count - 1}
        aria-label={`Move ${panel.title} down`}
        onClick={() => props.onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
    </span>
  );
}

/** Until the server's settings answer a save, the page keeps showing what was saved. */
interface Saved {
  readonly layout: ForkDashboardLayout;
  readonly before: ForkDashboardLayout;
}

export function DashboardPage() {
  const contentArea = workspaceAreaProps("home", 1, "Dashboard");
  // The minute tick is UTC without a zone suffix; it refreshes reset and relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const saved = useSavedDashboardLayout();
  const writer = useDashboardLayoutWriter();
  const [draft, setDraft] = useState<ForkDashboardLayout | null>(null);
  /** What the draft was edited from: a save is its revision plus one. */
  const [base, setBase] = useState<ForkDashboardLayout>(saved);
  const [pending, setPending] = useState<Saved | null>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const shown = pending !== null && pending.before === saved ? pending.layout : saved;
  const layout = draft ?? shown;
  const editing = draft !== null;
  const panels = resolvePanels(layout);
  const machineData = useDashboardMachineData(
    panels.some((panel) => panel.id === "machines" && (editing || !panel.hidden)),
  );

  const edit = (from: ForkDashboardLayout) => {
    setBase(from);
    setDraft(from);
    setStale(false);
  };
  const save = async (next: ForkDashboardLayout) => {
    // The save records the identities each machine has now, not only the ones it was saved with.
    const toSave = consolidateLayout(next, machineData.live);
    setSaving(true);
    const outcome = await writer.save(toSave, base);
    setSaving(false);
    if (outcome === "stale") {
      setStale(true);
      toastManager.add({
        type: "warning",
        title: "Changed on another device: reload",
        description: "Your edits are still here. Reload to start from the saved dashboard.",
      });
      return;
    }
    if (outcome !== "saved") return;
    setPending({ layout: { ...toSave, revision: base.revision + 1 }, before: saved });
    setDraft(null);
  };
  const reset = async () => {
    const confirmed = await requestConfirmDialog(
      `Reset the dashboard?\nAliases, icons, colours, sections, order and hidden items go back to the defaults on every client of ${writer.serverLabel ?? "this server"}.`,
      { variant: "destructive" },
    );
    if (confirmed) await save(resetLayout());
  };
  // Edits wait while a save is in flight, so none is lost between the request and its answer.
  const change = (next: ForkDashboardLayout) => {
    if (!saving) setDraft(next);
  };
  const panelBody = (id: DashboardPanelId) => {
    const onLayoutChange = editing ? change : undefined;
    switch (id) {
      case "machines":
        return (
          <DashboardMachines
            nowMs={nowMs}
            data={machineData}
            layout={layout}
            onLayoutChange={onLayoutChange}
          />
        );
      case "subscriptions":
        return (
          <DashboardSubscriptions nowMs={nowMs} layout={layout} onLayoutChange={onLayoutChange} />
        );
      case "threads":
        return <DashboardThreads nowMs={nowMs} />;
    }
  };
  const visiblePanels = editing ? panels : panels.filter((panel) => !panel.hidden);

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          {editing ? (
            <div className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm">
              <div className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-8">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium text-sm">Editing the dashboard</span>
                  <span className="text-muted-foreground text-xs">
                    {stale
                      ? "Changed on another device since you started. Reload to start from it; your edits stay until then."
                      : `Saved in ${writer.serverLabel ?? "the server"}'s settings, for every client of it.`}
                  </span>
                </div>
                <span className="ms-auto flex items-center gap-2">
                  {stale ? (
                    <Button
                      type="button"
                      variant="warning-outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => edit(saved)}
                    >
                      Reload
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive-outline"
                    size="sm"
                    disabled={saving || (isDefaultLayout(saved) && isDefaultLayout(layout))}
                    onClick={() => void reset()}
                  >
                    Reset
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving || stale}
                    onClick={() => void save(layout)}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </span>
              </div>
            </div>
          ) : null}
          <fieldset
            disabled={saving}
            className="mx-auto flex w-full max-w-[100rem] min-w-0 flex-col gap-12 px-4 py-10 sm:px-8"
          >
            {visiblePanels.map((panel, index) => (
              <Section
                key={panel.id}
                panel={panel}
                controls={
                  editing ? (
                    <PanelControls
                      panel={panel}
                      index={index}
                      count={visiblePanels.length}
                      onHidden={(hidden) => change(setPanelHidden(layout, panel.id, hidden))}
                      onMove={(steps) => change(movePanel(layout, panel.id, steps))}
                    />
                  ) : index === 0 ? (
                    <EditButton blocked={writer.blocked} onEdit={() => edit(shown)} />
                  ) : null
                }
              >
                {editing && panel.hidden ? (
                  <p className="text-muted-foreground text-sm">Hidden from the dashboard.</p>
                ) : (
                  panelBody(panel.id)
                )}
              </Section>
            ))}
            {visiblePanels.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-muted-foreground text-sm">Every section is hidden.</p>
                <EditButton blocked={writer.blocked} onEdit={() => edit(shown)} />
              </div>
            ) : null}
          </fieldset>
        </div>
      </div>
    </SidebarInset>
  );
}

function EditButton(props: { readonly blocked: string | null; readonly onEdit: () => void }) {
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={props.blocked !== null}
      onClick={props.onEdit}
    >
      <PencilIcon />
      Edit dashboard
    </Button>
  );
  if (props.blocked === null) return <span className="ms-auto flex">{button}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ms-auto flex" />}>{button}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.blocked}</TooltipPopup>
    </Tooltip>
  );
}
