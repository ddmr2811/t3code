import {
  ActivityIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleXIcon,
  HourglassIcon,
  ListChecksIcon,
  MessageCircleQuestionMarkIcon,
  UserRoundIcon,
} from "lucide-react";

import type { ThreadStatusKind } from "~/components/Sidebar.logic";
import { cn } from "~/lib/utils";

const GLYPHS = {
  approval: CircleAlertIcon,
  input: MessageCircleQuestionMarkIcon,
  guest: UserRoundIcon,
  working: ActivityIcon,
  connecting: CircleDotDashedIcon,
  waiting: HourglassIcon,
  failed: CircleXIcon,
  plan: ListChecksIcon,
  completed: CircleCheckIcon,
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
