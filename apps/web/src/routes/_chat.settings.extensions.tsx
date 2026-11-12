import { createFileRoute } from "@tanstack/react-router";

import { ForkExtensionsSettings } from "../components/settings/ForkExtensionsSettings";

function SettingsExtensionsRoute() {
  return <ForkExtensionsSettings />;
}

export const Route = createFileRoute("/_chat/settings/extensions")({
  component: SettingsExtensionsRoute,
});
