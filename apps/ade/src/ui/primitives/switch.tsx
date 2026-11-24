import { Switch as SwitchRoot, SwitchThumb } from "@ui-sdk/react/switch";
import type { ComponentProps } from "react";

import { cn } from "~/ui/utils";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchRoot>) {
  return (
    <SwitchRoot
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring data-checked:border-primary data-checked:bg-primary data-disabled:cursor-default data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchThumb className="size-3.5 rounded-full bg-foreground transition-transform data-checked:translate-x-4 data-checked:bg-background" />
    </SwitchRoot>
  );
}
