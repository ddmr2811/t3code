import {
  Tabs as TabsRoot,
  TabsList as TabsListRoot,
  TabsPanel as TabsPanelRoot,
  TabsTab as TabsTabRoot,
} from "@ui-sdk/react/tabs";
import type { ComponentProps } from "react";

import { cn } from "~/ui/utils";

export function Tabs({ className, ...props }: ComponentProps<typeof TabsRoot>) {
  return <TabsRoot className={cn("grid gap-2.5", className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsListRoot>) {
  return <TabsListRoot className={cn("flex gap-1.5", className)} {...props} />;
}

export function TabsTab({ className, ...props }: ComponentProps<typeof TabsTabRoot>) {
  return (
    <TabsTabRoot
      className={cn(
        "cursor-pointer rounded-sm border max-[720px]:min-h-11 max-[720px]:px-4 border-border px-2.5 py-1 text-[13px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring data-selected:border-primary data-selected:text-primary",
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof TabsPanelRoot>) {
  return <TabsPanelRoot className={cn("grid gap-2.5", className)} {...props} />;
}
