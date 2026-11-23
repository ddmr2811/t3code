// Fork-only: one page with every machine, the tailnet, the subscriptions and the active threads,
// arranged as saved in the settings of the server chosen to keep it, and editable in place.
import type { EnvironmentId, ForkDashboardLayout } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
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
import { ForkWidgetGrid } from "../widgets/ForkWidgets";
import { ActivityCard } from "../activity/ActivityCard";
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
import { useDashboardLayoutWriter, useDashboardOwner } from "./dashboardLayoutState";
import { type DashboardDraft, dashboardOwnerId, planDraft } from "./dashboardOwner.logic";
import { DashboardOwnerNotice, DashboardOwnerPicker } from "./DashboardOwnerPicker";

function Section(props: {
  readonly panel: ResolvedPanel;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const title = m(props.panel.title);
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div className="flex min-h-9 items-center gap-3">
        <h2
          className={cn(
            "font-serif text-3xl tracking-tight",
            props.panel.hidden && "text-muted-foreground",
          )}
        >
          {title}
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
  /** Why this panel cannot be changed here, or null. */
  readonly locked: string | null;
}) {
  const { panel } = props;
  const gt = useGT();
  const m = useMessages();
  const title = m(panel.title);
  const locked = props.locked !== null;
  const controls = (
    <span className="ms-auto flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-pressed={panel.hidden}
        disabled={locked}
        onClick={() => props.onHidden(!panel.hidden)}
      >
        {panel.hidden ? <EyeSlashIcon /> : <EyeIcon />}
        {panel.hidden
          ? gt("Hidden", { $context: "dashboard section state" })
          : gt("Shown", { $context: "dashboard section state" })}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        disabled={locked || props.index === 0}
        aria-label={gt("Move {title} up", { title })}
        onClick={() => props.onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        disabled={locked || props.index === props.count - 1}
        aria-label={gt("Move {title} down", { title })}
        onClick={() => props.onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
    </span>
  );
  if (props.locked === null) return controls;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ms-auto flex" />}>{controls}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.locked}</TooltipPopup>
    </Tooltip>
  );
}

/** Until the server's settings answer a save, the page keeps showing what was saved. */
interface Saved {
  readonly layout: ForkDashboardLayout;
  readonly before: ForkDashboardLayout;
}

export function DashboardPage() {
  const gt = useGT();
  const m = useMessages();
  const contentArea = workspaceAreaProps("home", 1, gt("Dashboard"));
  // The minute tick is UTC without a zone suffix; it refreshes reset and relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const owner = useDashboardOwner();
  const saved = owner.source.layout;
  const writer = useDashboardLayoutWriter(owner);
  const [opened, setOpened] = useState<DashboardDraft | null>(null);
  const [pending, setPending] = useState<Saved | null>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const ownerId = dashboardOwnerId(owner.source, owner.primaryId);
  const ownerLabel = writer.serverLabel ?? gt("this server");
  const plan =
    opened === null ? null : planDraft(opened, { ownerId, label: ownerLabel, layout: saved }, m);
  // The owner moved under a draft with nothing changed: edit mode closes with it.
  const draft = plan?.kind === "close" ? null : opened;
  // Dropped too, so moving back to that owner does not reopen it.
  if (plan?.kind === "close") setOpened(null);
  const moved = plan?.kind === "moved" ? plan : null;
  const shown = pending !== null && pending.before === saved ? pending.layout : saved;
  const layout = draft?.layout ?? shown;
  const editing = draft !== null;
  const panels = resolvePanels(layout);
  const machineData = useDashboardMachineData(
    panels.some((panel) => panel.id === "machines" && (editing || !panel.hidden)),
  );

  const edit = (from: ForkDashboardLayout, at = ownerId, label = ownerLabel) => {
    setOpened({ layout: from, base: from, ownerId: at, ownerLabel: label });
    setStale(false);
  };
  const switched = (next: ForkDashboardLayout, at: EnvironmentId, label: string) => {
    setPending(null);
    if (editing) edit(next, at, label);
  };
  /** Saves `next` as the revision after `base`, to the owner the writer targets now. */
  const write = async (next: ForkDashboardLayout, base: ForkDashboardLayout) => {
    if (draft === null) return;
    // The save records the identities each machine has now, not only the ones it was saved with.
    const toSave = consolidateLayout(next, machineData.live);
    setSaving(true);
    const outcome = await writer.save(toSave, base);
    setSaving(false);
    if (outcome === "stale") {
      setStale(true);
      toastManager.add({
        type: "warning",
        title: gt("Changed on another device: reload"),
        description: gt("Your edits are still here. Reload to start from the saved dashboard."),
      });
      return;
    }
    if (outcome !== "saved") return;
    setPending({ layout: { ...toSave, revision: base.revision + 1 }, before: saved });
    // Only the draft this save started from closes; one opened meanwhile stays.
    setOpened((current) => (current === draft ? null : current));
  };
  const save = async (next: ForkDashboardLayout) => {
    // A draft for another owner never lands on this one unasked: the notice offers it instead.
    if (plan?.kind !== "save") return;
    await write(next, plan.base);
  };
  const copyMoved = async () => {
    if (moved === null || draft === null) return;
    if (moved.copyConfirm !== null) {
      const confirmed = await requestConfirmDialog(moved.copyConfirm, { variant: "destructive" });
      if (!confirmed) return;
    }
    await write(draft.layout, moved.copyBase);
  };
  const reset = async () => {
    const confirmed = await requestConfirmDialog(
      writer.serverLabel === null
        ? gt(
            "Reset the dashboard?\nAliases, icons, colours, sections, order and hidden items go back to the defaults on every client of this server.",
          )
        : gt(
            "Reset the dashboard?\nAliases, icons, colours, sections, order and hidden items go back to the defaults on every client of {label}.",
            { label: writer.serverLabel },
          ),
      { variant: "destructive" },
    );
    if (confirmed) await save(resetLayout());
  };
  // Edits wait while a save is in flight, so none is lost between the request and its answer.
  const change = (next: ForkDashboardLayout) => {
    if (!saving) setOpened((current) => (current === null ? null : { ...current, layout: next }));
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
      case "charts":
        return <ForkWidgetGrid variant="panel" />;
      case "threads":
        return <DashboardThreads nowMs={nowMs} />;
      case "activity":
        return <ActivityCard nowMs={nowMs} />;
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
                  <span className="font-medium text-sm">
                    <T>Editing the dashboard</T>
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      moved === null ? "text-muted-foreground" : "text-warning-foreground",
                    )}
                  >
                    {moved !== null
                      ? moved.notice
                      : stale
                        ? gt(
                            "Changed on another device since you started. Reload to start from it; your edits stay until then.",
                          )
                        : gt("Changes show on every client that saves its Dashboard there.")}
                  </span>
                </div>
                {moved === null ? (
                  <DashboardOwnerPicker
                    owner={owner}
                    writer={writer}
                    layout={layout}
                    disabled={saving}
                    onBusy={setSaving}
                    onSwitched={switched}
                  />
                ) : null}
                {moved !== null ? (
                  <span className="ms-auto flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => setOpened(null)}
                    >
                      <T>Discard</T>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving || writer.blocked !== null}
                      onClick={() => void copyMoved()}
                    >
                      {saving ? gt("Copying…") : moved.copyLabel}
                    </Button>
                  </span>
                ) : (
                  <span className="ms-auto flex items-center gap-2">
                    {stale ? (
                      <Button
                        type="button"
                        variant="warning-outline"
                        size="sm"
                        disabled={saving}
                        onClick={() => edit(saved)}
                      >
                        <T>Reload</T>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive-outline"
                      size="sm"
                      disabled={saving || (isDefaultLayout(saved) && isDefaultLayout(layout))}
                      onClick={() => void reset()}
                    >
                      <T>Reset</T>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => setOpened(null)}
                    >
                      <T>Cancel</T>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving || stale}
                      onClick={() => void save(layout)}
                    >
                      {saving ? gt("Saving…") : gt("Save")}
                    </Button>
                  </span>
                )}
              </div>
            </div>
          ) : null}
          <fieldset
            disabled={saving}
            className="mx-auto flex w-full max-w-[100rem] min-w-0 flex-col gap-12 px-4 py-10 sm:px-8"
          >
            {editing ? null : (
              <DashboardOwnerNotice
                owner={owner}
                writer={writer}
                layout={layout}
                onSwitched={switched}
              />
            )}
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
                      locked={
                        panel.id === "charts"
                          ? writer.chartsBlocked
                          : panel.id === "activity"
                            ? writer.activityBlocked
                            : null
                      }
                    />
                  ) : index === 0 ? (
                    <EditButton blocked={writer.blocked} onEdit={() => edit(shown)} />
                  ) : null
                }
              >
                {editing && panel.hidden ? (
                  <p className="text-muted-foreground text-sm">
                    <T>Hidden from the dashboard.</T>
                  </p>
                ) : (
                  panelBody(panel.id)
                )}
              </Section>
            ))}
            {visiblePanels.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-muted-foreground text-sm">
                  <T>Every section is hidden.</T>
                </p>
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
      <PencilSimpleIcon />
      <T>Edit dashboard</T>
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
