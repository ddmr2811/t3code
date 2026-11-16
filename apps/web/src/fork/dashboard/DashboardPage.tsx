// Fork-only: one page with every machine, the tailnet, the subscriptions and the active threads.
import type { ReactNode } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { SidebarInset } from "../../components/ui/sidebar";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { DashboardMachines } from "./DashboardMachines";
import { DashboardSubscriptions } from "./DashboardSubscriptions";
import { DashboardThreads } from "./DashboardThreads";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <h2 className="font-serif text-3xl tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export function DashboardPage() {
  const contentArea = workspaceAreaProps("home", 1, "Dashboard");
  // The minute tick is UTC without a zone suffix; it refreshes reset and relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-12 px-4 py-10 sm:px-8">
            <Section title="Machines">
              <DashboardMachines nowMs={nowMs} />
            </Section>
            <Section title="Subscriptions">
              <DashboardSubscriptions nowMs={nowMs} />
            </Section>
            <Section title="Active threads">
              <DashboardThreads nowMs={nowMs} />
            </Section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
