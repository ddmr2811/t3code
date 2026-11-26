// Adaptado de FrameStatus.tsx de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9), MIT,
// © 2026 Adrián Alonso. Ver ../backroom/NOTICE.
import { useAtom } from "@effect/atom-react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { botMascot } from "../backroom/AgentAvatar.tsx";
import { Mascot } from "../backroom/Mascot.tsx";
import { type BotNotice, useBotNotices } from "../decisions/BotNotices.tsx";
import { KIND_LABELS } from "../decisions/DecisionsPanel.tsx";
import { buildPendingTrayItems } from "../decisions/tray.logic.ts";
import { useDecisionsPanel } from "../sidebar/Sidebar.tsx";
import { useBotOf, useMachineLabel } from "./ForYou.tsx";
import { forYouEntries, reviewEvent } from "./home.logic.ts";

/** What waited already when the ADE opened is no news; only what arrives after it is. */
const OPENED_AT = DateTime.toEpochMillis(DateTime.nowUnsafe());

// Closed toasts stay closed across screens for this session.
const dismissedAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-review-toast-dismissed"),
);

const noticeAt = (notice: BotNotice): string | null => {
  switch (notice.type) {
    case "workflow":
      return notice.open.question.askedAt;
    case "integration":
      return notice.request.createdAt;
    case "proposal":
      return notice.proposal.createdAt;
    case "handoff":
      return notice.handoff.createdAt;
    case "install":
      return notice.gap.updatedAt;
    case "unreadable":
      return null;
  }
};

/** «Listo para que lo revises»: once per thing that comes to wait on the user, until closed. */
export function ReviewToast() {
  const { threads, snoozedKeys, setOpen } = useDecisionsPanel();
  const notices = useBotNotices();
  const machineOf = useMachineLabel();
  const botOf = useBotOf();
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const entries = forYouEntries(
    notices,
    buildPendingTrayItems(threads, machineOf),
    snoozedKeys,
  ).map((entry) => ({
    ...entry,
    at: "notice" in entry ? noticeAt(entry.notice) : entry.item.thread.updatedAt,
  }));
  const event = reviewEvent(entries, OPENED_AT, dismissed);
  if (event === null) return null;

  const bot =
    "notice" in event
      ? (event.notice.from ?? null)
      : botOf(event.item.thread.environmentId, event.item.thread.id);
  const name =
    bot?.name ??
    ("notice" in event
      ? event.notice.type === "workflow"
        ? (event.notice.open.workflow ?? "Flujo")
        : "Bots"
      : event.item.thread.title);
  const what = "notice" in event ? event.notice.label : KIND_LABELS[event.item.primaryKind];
  return (
    <div className="v3-frame-status br-review" role="status">
      <span className="v3-aura" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="v3-status-pill">
        <button type="button" className="br-review-open" onClick={() => setOpen(true)}>
          {bot === null ? (
            <ChatCircleIcon size={22} aria-hidden className="br-review-glyph" />
          ) : (
            <Mascot kind={botMascot(bot)} />
          )}
          <strong>{name}</strong>
          <span className="v3-status-state" data-state="ready">
            <CheckIcon size={13} weight="bold" aria-hidden />
            Listo para que lo revises
          </span>
          <small>{what}</small>
        </button>
        <button
          type="button"
          className="br-review-close"
          aria-label="Cerrar el aviso"
          onClick={() => setDismissed(new Set([...dismissed, event.key]))}
        >
          <XIcon size={13} aria-hidden />
        </button>
      </span>
      <span className="v3-edge" aria-hidden />
    </div>
  );
}
