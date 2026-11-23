// Fork-only: the icons and colours a Dashboard machine can wear, and the picker for them.
import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { GameControllerIcon } from "@phosphor-icons/react/dist/csr/GameController";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { WifiHighIcon } from "@phosphor-icons/react/dist/csr/WifiHigh";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { DeviceTabletIcon } from "@phosphor-icons/react/dist/csr/DeviceTablet";
import { TelevisionIcon } from "@phosphor-icons/react/dist/csr/Television";
import { msg, T, useGT, useMessages } from "gt-react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { Toggle } from "../../components/ui/toggle";
import { cn } from "../../lib/utils";
import {
  MACHINE_COLORS,
  MACHINE_ICONS,
  type MachineColor,
  type MachineIcon,
  type MachineKind,
} from "./dashboardLayout.logic";

const MACHINE_ICON_COMPONENTS: Record<MachineIcon, PhosphorIcon> = {
  monitor: MonitorIcon,
  laptop: LaptopIcon,
  server: HardDrivesIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  cpu: CpuIcon,
  router: WifiHighIcon,
  smartphone: DeviceMobileIcon,
  tablet: DeviceTabletIcon,
  tv: TelevisionIcon,
  gamepad: GameControllerIcon,
  house: HouseIcon,
};

/** Written out whole so Tailwind keeps them; the 500 shades read on light and dark themes. */
const TEXT: Record<MachineColor, string> = {
  red: "text-red-500",
  orange: "text-orange-500",
  amber: "text-amber-500",
  lime: "text-lime-500",
  emerald: "text-emerald-500",
  teal: "text-teal-500",
  sky: "text-sky-500",
  blue: "text-blue-500",
  violet: "text-violet-500",
  pink: "text-pink-500",
};
const SWATCH: Record<MachineColor, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  lime: "bg-lime-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

/** Each icon's toggle, named in full. */
const ICON_LABELS: Record<MachineIcon, string> = {
  monitor: msg("Monitor icon"),
  laptop: msg("Laptop icon"),
  server: msg("Server icon"),
  cloud: msg("Cloud icon"),
  database: msg("Database icon"),
  cpu: msg("Chip icon"),
  router: msg("Router icon"),
  smartphone: msg("Phone icon"),
  tablet: msg("Tablet icon"),
  tv: msg("TV icon"),
  gamepad: msg("Console icon"),
  house: msg("Home icon"),
};
const COLOR_NAMES: Record<MachineColor, string> = {
  red: msg("Red", { $context: "colour name" }),
  orange: msg("Orange", { $context: "colour name" }),
  amber: msg("Amber", { $context: "colour name" }),
  lime: msg("Lime", { $context: "colour name" }),
  emerald: msg("Green", { $context: "colour name" }),
  teal: msg("Teal", { $context: "colour name" }),
  sky: msg("Sky", { $context: "colour name" }),
  blue: msg("Blue", { $context: "colour name" }),
  violet: msg("Violet", { $context: "colour name" }),
  pink: msg("Pink", { $context: "colour name" }),
};

const DEFAULT_ICON: Record<MachineKind, MachineIcon> = {
  environment: "monitor",
  exporter: "server",
  peer: "monitor",
};

/** The machine's icon, or the kind's when only a colour is chosen; nothing when neither is. */
export function MachineGlyph(props: {
  readonly icon: MachineIcon | null;
  readonly color: MachineColor | null;
  readonly kind: MachineKind | null;
  readonly always?: boolean;
}) {
  if (props.icon === null && props.color === null && !props.always) return null;
  const Icon = MACHINE_ICON_COMPONENTS[props.icon ?? DEFAULT_ICON[props.kind ?? "environment"]];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        props.color === null ? "text-muted-foreground" : TEXT[props.color],
      )}
    />
  );
}

export function AppearancePicker(props: {
  readonly label: string;
  readonly kind: MachineKind | null;
  readonly icon: MachineIcon | null;
  readonly color: MachineColor | null;
  readonly onChange: (next: { icon?: MachineIcon | null; color?: MachineColor | null }) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const appearanceLabel = gt("Icon and colour of {label}", { label: props.label });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="icon-xs" aria-label={appearanceLabel} />
        }
      >
        <MachineGlyph icon={props.icon} color={props.color} kind={props.kind} always />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact" aria-label={appearanceLabel}>
        <div className="flex w-56 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-muted-foreground">
              <T>Icon</T>
            </span>
            <div className="grid grid-cols-6 gap-1">
              {MACHINE_ICONS.map((icon) => {
                const Icon = MACHINE_ICON_COMPONENTS[icon];
                return (
                  <Toggle
                    key={icon}
                    size="xs"
                    variant="ghost"
                    aria-label={m(ICON_LABELS[icon])}
                    pressed={props.icon === icon}
                    onPressedChange={(pressed) => props.onChange({ icon: pressed ? icon : null })}
                  >
                    <Icon />
                  </Toggle>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-muted-foreground">
              <T>Colour</T>
            </span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                aria-label={gt("No colour")}
                aria-pressed={props.color === null}
                onClick={() => props.onChange({ color: null })}
                className={cn(
                  "size-5 rounded-full border border-dashed border-muted-foreground/60 outline-none transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  props.color === null && "ring-2 ring-inset ring-foreground",
                )}
              />
              {MACHINE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={m(COLOR_NAMES[color])}
                  aria-pressed={props.color === color}
                  onClick={() => props.onChange({ color })}
                  className={cn(
                    "size-5 rounded-full outline-none transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    SWATCH[color],
                    props.color === color && "ring-2 ring-inset ring-foreground",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
