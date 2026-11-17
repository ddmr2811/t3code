import { createFileRoute } from "@tanstack/react-router";

import { ActivityPage } from "../fork/activity/ActivityPage";

// Fork: the Dashboard's "What the AI did", in full.
export const Route = createFileRoute("/_chat/activity")({
  component: ActivityPage,
});
