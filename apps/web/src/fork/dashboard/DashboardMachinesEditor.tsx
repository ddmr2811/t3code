// Fork-only: the Dashboard's machines in edit mode: one list per section, each machine with its
// alias, look, section and visibility. Rows drag by their handle; the arrows do the same by keyboard.
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ForkDashboardLayout } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";
import {
  addSection,
  BUILT_IN_SECTIONS,
  forgetMachine,
  moveMachine,
  moveMachineToSection,
  moveSection,
  nextSectionId,
  type PlacedMachine,
  type PlacedSection,
  removeSection,
  renameSection,
  updateMachine,
} from "./dashboardLayout.logic";
import { AppearancePicker } from "./machineAppearance";

export interface MachineStatus {
  readonly online: boolean;
  /** "Offline · seen 2h ago", "node_exporter", or the like. */
  readonly detail: string | null;
}

interface EditorProps<T> {
  readonly sections: ReadonlyArray<PlacedSection<T>>;
  readonly layout: ForkDashboardLayout;
  readonly onChange: (layout: ForkDashboardLayout) => void;
  readonly status: (machine: PlacedMachine<T>) => MachineStatus;
}

export function DashboardMachinesEditor<T>(props: EditorProps<T>) {
  const customSections = props.sections.filter((section) => section.custom);
  return (
    <div className="flex flex-col gap-3">
      {props.sections.map((section) => (
        <SectionEditor
          key={section.id}
          {...props}
          section={section}
          position={customSections.findIndex((entry) => entry.id === section.id)}
          customCount={customSections.length}
        />
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            props.onChange(addSection(props.layout, nextSectionId(props.layout), "New section"))
          }
        >
          <PlusIcon />
          Add section
        </Button>
      </div>
    </div>
  );
}

function SectionEditor<T>(
  props: EditorProps<T> & {
    readonly section: PlacedSection<T>;
    /** Among the custom sections; -1 for a built-in one. */
    readonly position: number;
    readonly customCount: number;
  },
) {
  const { section, layout, onChange } = props;
  const keys = section.machines.map((machine) => machine.key);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = keys.indexOf(String(event.active.id));
    const to = keys.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1)
      onChange(moveMachine(layout, section, String(event.active.id), to - from));
  };
  return (
    <section
      aria-label={section.name}
      className={cn(
        "flex flex-col rounded-lg border bg-card",
        section.id === "tailnet" && "border-dashed",
      )}
    >
      <header className="flex min-h-11 items-center gap-2 border-b px-3 py-1.5">
        {section.custom ? (
          <Input
            key={`${section.id}:${section.name}`}
            size="sm"
            aria-label="Section name"
            defaultValue={section.name}
            autoFocus={section.name === "New section" && section.machines.length === 0}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) =>
              onChange(renameSection(layout, section.id, event.currentTarget.value))
            }
            className="max-w-64"
          />
        ) : (
          <span className="text-3xs font-medium uppercase tracking-widest text-muted-foreground">
            {section.name}
          </span>
        )}
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {section.machines.length}
        </span>
        {section.custom ? (
          <span className="ms-auto flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.position === 0}
              aria-label={`Move section ${section.name} up`}
              onClick={() => onChange(moveSection(layout, section.id, -1))}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.position === props.customCount - 1}
              aria-label={`Move section ${section.name} down`}
              onClick={() => onChange(moveSection(layout, section.id, 1))}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Delete section ${section.name}`}
              onClick={() => onChange(removeSection(layout, section.id))}
            >
              <Trash2Icon />
            </Button>
          </span>
        ) : null}
      </header>
      {section.machines.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">
          {section.custom
            ? "Empty. Pick this section in a machine's Section menu to move it here."
            : "No machines here."}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ol
              aria-label={`${section.name}, in order`}
              className="flex flex-col divide-y divide-border/60"
            >
              {section.machines.map((machine, index) => (
                <MachineRow
                  key={machine.key}
                  {...props}
                  machine={machine}
                  index={index}
                  count={section.machines.length}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function MachineRow<T>(
  props: EditorProps<T> & {
    readonly section: PlacedSection<T>;
    readonly machine: PlacedMachine<T>;
    readonly index: number;
    readonly count: number;
  },
) {
  const { machine, layout, onChange, section } = props;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: machine.key });
  const status = props.status(machine);
  const kind = machine.live?.kind ?? null;
  const sectionChoices = [
    {
      id: machine.defaultSection,
      name: BUILT_IN_SECTIONS[machine.defaultSection as keyof typeof BUILT_IN_SECTIONS],
    },
    ...props.sections
      .filter((entry) => entry.custom)
      .map((entry) => ({ id: entry.id, name: entry.name })),
  ];
  const currentSection = machine.assignedSection ?? machine.defaultSection;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5 ps-1.5 pe-2",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
        machine.hidden && "text-muted-foreground",
      )}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        tabIndex={-1}
        aria-hidden
        className="flex size-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <AppearancePicker
        label={machine.label}
        kind={kind}
        icon={machine.icon}
        color={machine.color}
        onChange={(next) => onChange(updateMachine(layout, machine, next))}
      />
      <span className="w-48 min-w-0 flex-1 sm:w-64 sm:flex-none">
        <Input
          key={`${machine.key}:${machine.alias ?? ""}`}
          size="sm"
          aria-label={`Name shown for ${machine.name}`}
          placeholder={machine.name}
          defaultValue={machine.alias ?? ""}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const alias = event.currentTarget.value.trim() || null;
            if (alias !== machine.alias) onChange(updateMachine(layout, machine, { alias }));
          }}
        />
      </span>
      <span className="order-last flex min-w-0 basis-full items-center gap-2 ps-16 md:order-none md:basis-auto md:flex-1 md:ps-0">
        <StatusBadge machine={machine} status={status} />
        {machine.hidden ? (
          <Badge variant="outline" size="sm">
            <EyeOffIcon aria-hidden className="-ms-px size-2.5" />
            Hidden
          </Badge>
        ) : null}
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {[machine.alias === null ? null : machine.name, status.detail]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span className="w-56 shrink-0">
        <Select
          value={currentSection}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== currentSection) {
              onChange(moveMachineToSection(layout, machine, value));
            }
          }}
        >
          <SelectTrigger
            size="xs"
            aria-label={`Section of ${machine.label}`}
            className="w-full min-w-0"
          >
            <SelectValue>
              {(value: string | null) =>
                sectionChoices.find((choice) => choice.id === value)?.name ?? "Section"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {sectionChoices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-0.5 md:ms-0">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-pressed={machine.hidden}
          aria-label={machine.hidden ? `Show ${machine.label}` : `Hide ${machine.label}`}
          onClick={() => onChange(updateMachine(layout, machine, { hidden: !machine.hidden }))}
        >
          {machine.hidden ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.index === 0}
          aria-label={`Move ${machine.label} up`}
          onClick={() => onChange(moveMachine(layout, section, machine.key, -1))}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.index === props.count - 1}
          aria-label={`Move ${machine.label} down`}
          onClick={() => onChange(moveMachine(layout, section, machine.key, 1))}
        >
          <ArrowDownIcon />
        </Button>
        {machine.live === null ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Forget ${machine.label}`}
            onClick={() => onChange(forgetMachine(layout, machine))}
          >
            <XIcon />
          </Button>
        ) : (
          <span aria-hidden className="size-7 sm:size-6" />
        )}
      </span>
    </li>
  );
}

function StatusBadge<T>(props: {
  readonly machine: PlacedMachine<T>;
  readonly status: MachineStatus;
}) {
  if (props.machine.live === null) {
    return (
      <Badge variant="warning" size="sm">
        {props.machine.ambiguous ? "Ambiguous" : "Not seen"}
      </Badge>
    );
  }
  return props.status.online ? (
    <Badge variant="success" size="sm">
      <span aria-hidden className="-ms-px size-1.5 rounded-full bg-success" />
      Online
    </Badge>
  ) : (
    <Badge variant="secondary" size="sm">
      <span aria-hidden className="-ms-px size-1.5 rounded-full bg-muted-foreground/60" />
      Offline
    </Badge>
  );
}
