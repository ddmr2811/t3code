// Fork-only: the icons and colours a Dashboard machine can wear, and the picker for them.
import {
  CloudIcon,
  CpuIcon,
  DatabaseIcon,
  Gamepad2Icon,
  HouseIcon,
  LaptopIcon,
  type LucideIcon,
  MonitorIcon,
  RouterIcon,
  ServerIcon,
  SmartphoneIcon,
  TabletIcon,
  TvIcon,
} from "lucide-react";

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

const MACHINE_ICON_COMPONENTS: Record<MachineIcon, LucideIcon> = {
  monitor: MonitorIcon,
  laptop: LaptopIcon,
  server: ServerIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  cpu: CpuIcon,
  router: RouterIcon,
  smartphone: SmartphoneIcon,
  tablet: TabletIcon,
  tv: TvIcon,
  gamepad: Gamepad2Icon,
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

const ICON_NAMES: Record<MachineIcon, string> = {
  monitor: "Monitor",
  laptop: "Laptop",
  server: "Server",
  cloud: "Cloud",
  database: "Database",
  cpu: "Chip",
  router: "Router",
  smartphone: "Phone",
  tablet: "Tablet",
  tv: "TV",
  gamepad: "Console",
  house: "Home",
};
const COLOR_NAMES: Record<MachineColor, string> = {
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  lime: "Lime",
  emerald: "Green",
  teal: "Teal",
  sky: "Sky",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
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
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={`Icon and colour of ${props.label}`}
          />
        }
      >
        <MachineGlyph icon={props.icon} color={props.color} kind={props.kind} always />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        padding="compact"
        aria-label={`Icon and colour of ${props.label}`}
      >
        <div className="flex w-56 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-muted-foreground">Icon</span>
            <div className="grid grid-cols-6 gap-1">
              {MACHINE_ICONS.map((icon) => {
                const Icon = MACHINE_ICON_COMPONENTS[icon];
                return (
                  <Toggle
                    key={icon}
                    size="xs"
                    variant="ghost"
                    aria-label={`${ICON_NAMES[icon]} icon`}
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
            <span className="text-2xs font-medium text-muted-foreground">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                aria-label="No colour"
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
                  aria-label={COLOR_NAMES[color]}
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
