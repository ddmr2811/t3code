import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";

import type { ThreadStatusKind } from "~/components/Sidebar.logic";
import { cn } from "~/lib/utils";

const GLYPHS = {
  approval: WarningCircleIcon,
  input: ChatCircleDotsIcon,
  guest: UserIcon,
  working: PulseIcon,
  connecting: CircleDashedIcon,
  waiting: HourglassIcon,
  failed: XCircleIcon,
  plan: ListChecksIcon,
  completed: CheckCircleIcon,
} satisfies Record<ThreadStatusKind, unknown>;

/** Each thread state has its own shape; colour comes from the parent's `colorClass`. */
export function ThreadStatusGlyph({
  kind,
  pulse = false,
  className,
}: {
  kind: ThreadStatusKind;
  pulse?: boolean;
  className?: string;
}) {
  const Glyph = GLYPHS[kind];
  return (
    <Glyph
      aria-hidden
      className={cn("shrink-0", pulse && "motion-safe:animate-status-pulse", className)}
    />
  );
}
