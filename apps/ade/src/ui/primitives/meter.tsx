import {
  Meter as MeterRoot,
  MeterIndicator,
  MeterLabel,
  MeterTrack,
  MeterValue,
} from "@ui-sdk/react/meter";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/ui/utils";

export function Meter({
  label,
  className,
  ...props
}: ComponentProps<typeof MeterRoot> & { readonly label: ReactNode }) {
  return (
    <MeterRoot
      className={cn("grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-xs", className)}
      {...props}
    >
      <MeterLabel className="text-muted-foreground">{label}</MeterLabel>
      <MeterValue className="text-muted-foreground tabular-nums" />
      <MeterTrack className="col-span-2 h-1 overflow-hidden rounded-full bg-border">
        <MeterIndicator className="h-full bg-primary" />
      </MeterTrack>
    </MeterRoot>
  );
}
