import { createFileRoute } from "@tanstack/react-router";

import { DashboardPage } from "../fork/dashboard/DashboardPage";

// Fork: the Dashboard.
export const Route = createFileRoute("/_chat/dashboard")({
  component: DashboardPage,
});
