// Fork-only: "Saved on": moves the Dashboard to another environment's settings, either copying the
// layout on screen there or taking the one it already keeps.
import type { EnvironmentId, ForkDashboardLayout } from "@t3tools/contracts";
import { CloudOffIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import type { DashboardLayoutWriter, DashboardOwnerState } from "./dashboardLayoutState";
import {
  operationIsCurrent,
  ownerOptions,
  type OwnerSwitch,
  type OwnerSwitchChoice,
  planOwnerSwitch,
} from "./dashboardOwner.logic";

export function DashboardOwnerPicker(props: {
  readonly owner: DashboardOwnerState;
  readonly writer: DashboardLayoutWriter;
  /** The layout on screen, which "Copy this layout there" takes. */
  readonly layout: ForkDashboardLayout;
  readonly disabled: boolean;
  readonly onBusy?: (busy: boolean) => void;
  /** Called once switched, with what the Dashboard shows from now on. */
  readonly onSwitched: (next: ForkDashboardLayout, ownerId: EnvironmentId, label: string) => void;
}) {
  const { owner, writer } = props;
  const operations = useRef(0);
  const { source, primaryId, candidates } = owner;
  const current = source.kind === "primary" ? primaryId : source.environmentId;
  const options = ownerOptions({ candidates, primaryId, current });
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = target === null ? null : candidates.find((c) => c.environmentId === target);
  const nameOf = (environmentId: EnvironmentId | null) => {
    const option = options.find((entry) => entry.environmentId === environmentId);
    if (option === undefined) return "No server";
    return option.primary ? `${option.label} · primary` : option.label;
  };

  const locked = props.disabled || busy;
  const finish = async (choice: OwnerSwitchChoice) => {
    if (chosen == null || locked) return;
    const plan = planOwnerSwitch({ choice, target: chosen, primaryId, layout: props.layout });
    if (plan === null) return;
    if (plan.confirm !== null) {
      const confirmed = await requestConfirmDialog(plan.confirm, { variant: "destructive" });
      if (!confirmed) return;
    }
    operations.current += 1;
    const operation = { id: operations.current, owner: getClientSettings().forkDashboardOwner };
    const isCurrent = (owner: EnvironmentId | null) =>
      operationIsCurrent(
        { id: operation.id, owner },
        { id: operations.current, owner: getClientSettings().forkDashboardOwner },
      );
    setBusy(true);
    props.onBusy?.(true);
    const done = await applyOwnerSwitch(plan, writer, chosen.label, () =>
      isCurrent(operation.owner),
    ).catch(() => false);
    setBusy(false);
    props.onBusy?.(false);
    // Another switch, here or on another device, answered meanwhile: its result stands.
    if (!done || !isCurrent(plan.owner)) return;
    setTarget(null);
    props.onSwitched(plan.next, chosen.environmentId, chosen.label);
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm">Saved on</span>
      <Select
        value={target ?? current ?? ""}
        disabled={locked}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          setTarget(value === current ? null : (value as EnvironmentId));
        }}
      >
        <SelectTrigger size="sm" className="w-56" aria-label="Saved on">
          <SelectValue>
            {(value: string | null) => nameOf(value as EnvironmentId | null)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem
              key={option.environmentId}
              value={option.environmentId}
              disabled={option.disabled && option.environmentId !== current}
            >
              {option.label}
              {option.primary ? <span className="text-muted-foreground"> · primary</span> : null}
              {option.disabled ? (
                <span className="text-muted-foreground"> · unavailable</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {chosen != null ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void finish("copy")}
          >
            Copy this layout there
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void finish("use")}
          >
            Use the one there
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => setTarget(null)}
          >
            Keep {nameOf(current)}
          </Button>
        </>
      ) : null}
    </span>
  );
}

/** Makes the switch's one write, then stores the owner; false when the write did not land. */
async function applyOwnerSwitch(
  plan: OwnerSwitch,
  writer: DashboardLayoutWriter,
  targetLabel: string,
  stillCurrent: () => boolean,
): Promise<boolean> {
  if (plan.write !== null) {
    const outcome = await writer.copyTo(
      plan.write.environmentId,
      plan.write.layout,
      plan.write.base,
    );
    if (outcome === "stale") {
      toastManager.add({
        type: "warning",
        title: `Changed on ${targetLabel} meanwhile`,
        description: "Nothing was copied. Choose the server again to see its layout.",
      });
    }
    if (outcome !== "saved") return false;
  }
  // The owner moved while the copy was in flight: keep the newer choice.
  if (!stillCurrent()) return false;
  await updateClientSettings({ forkDashboardOwner: plan.owner });
  return true;
}

/** While the chosen server cannot answer, the Dashboard is read only and says why. */
export function DashboardOwnerNotice(props: {
  readonly owner: DashboardOwnerState;
  readonly writer: DashboardLayoutWriter;
  readonly layout: ForkDashboardLayout;
  readonly onSwitched: (next: ForkDashboardLayout, ownerId: EnvironmentId, label: string) => void;
}) {
  const { source } = props.owner;
  if (source.kind !== "unavailable") return null;
  return (
    <Alert variant="warning">
      <CloudOffIcon />
      <AlertDescription>{source.notice}</AlertDescription>
      <AlertAction>
        <DashboardOwnerPicker
          owner={props.owner}
          writer={props.writer}
          layout={props.layout}
          disabled={false}
          onSwitched={props.onSwitched}
        />
      </AlertAction>
    </Alert>
  );
}
