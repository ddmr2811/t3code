// Fork-only: one place for the questions and approvals every thread on this machine waits on.
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  type PendingThreadRequests,
  seedUserInputDraftAnswers,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { ArrowRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { ChildApproval } from "~/components/chat/ChildThreadApprovals";
import { ComposerPendingUserInputPanel } from "~/components/chat/ComposerPendingUserInputPanel";
import { Button } from "~/components/ui/button";
import { derivePendingUserInputProgress } from "~/pendingUserInput";
import type { PendingUserInput } from "~/session-logic";
import { useProject } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useDecisionsPanel } from "./decisionsState";

const NO_REQUESTS_ATOM = Atom.make<PendingThreadRequests | null>(null).pipe(
  Atom.withLabel("fork-decisions:no-requests"),
);

export function DecisionsPanel() {
  const gt = useGT();
  const { threads, open, setOpen } = useDecisionsPanel();
  if (!open) return null;
  return (
    <aside
      id="fork-decisions-panel"
      aria-label={gt("Decisions")}
      className="fixed top-(--workspace-topbar-height) right-0 bottom-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-2xl"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
      }}
    >
      <header className="flex items-start justify-between gap-3 border-b px-5 pt-4 pb-3">
        <div className="min-w-0">
          <p className="font-mono text-2xs text-muted-foreground uppercase tracking-wider">
            {gt("{count, plural, =0 {Nothing pending} other {{count} pending}}", {
              count: threads.length,
            })}
          </p>
          <h2 className="font-bold text-3xl tracking-tight">{gt("Decisions")}</h2>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Close decisions")}
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {threads.length === 0 ? (
          <p className="px-2 py-6 text-center text-muted-foreground text-sm">
            {gt("Nothing is waiting on you.")}
          </p>
        ) : (
          threads.map((thread) => (
            <DecisionCard key={`${thread.environmentId}:${thread.id}`} thread={thread} />
          ))
        )}
      </div>
    </aside>
  );
}

function DecisionCard({ thread }: { thread: EnvironmentThreadShell }) {
  const gt = useGT();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  // Only a request the thread itself holds needs its detail stream.
  const requests = useAtomValue(
    thread.hasPendingApprovals || thread.hasPendingUserInput
      ? environmentThreadDetails.pendingRequestsAtom(threadRef)
      : NO_REQUESTS_ATOM,
  );
  const approvals = requests?.approvals ?? [];
  const question = requests?.userInputs[0] ?? null;
  const tag = thread.hasPendingApprovals
    ? gt("Approval", { $context: "noun, a request waiting for the user to approve it" })
    : thread.hasPendingUserInput
      ? gt("Question", { $context: "noun, a question an agent asks the user" })
      : (thread.pendingGuestMessageCount ?? 0) > 0
        ? gt("Guest", { $context: "noun, a guest asks to send a message" })
        : gt("Plan", { $context: "noun, a proposed plan waiting for approval" });
  return (
    <section
      aria-label={thread.title}
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-sm bg-primary px-1.5 py-0.5 font-mono font-semibold text-2xs text-primary-foreground uppercase tracking-wider">
          {tag}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {project?.title ?? ""}
        </span>
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(threadRef)}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {gt("Open thread")}
          <ArrowRightIcon aria-hidden className="size-3" />
        </Link>
      </div>
      <h3 className="font-semibold text-lg leading-snug tracking-tight">{thread.title}</h3>
      {approvals.map((approval) => (
        <ChildApproval
          key={approval.requestId}
          entry={{ thread: threadRef, title: thread.title, approval }}
        />
      ))}
      {question !== null ? (
        <DecisionQuestion key={question.requestId} threadRef={threadRef} prompt={question} />
      ) : null}
      {!thread.hasPendingApprovals && !thread.hasPendingUserInput ? (
        <p className="text-muted-foreground text-sm">
          {(thread.pendingGuestMessageCount ?? 0) > 0
            ? gt("A guest wants to send a message. Review it in the thread.")
            : gt("The plan is ready. Review it in the thread.")}
        </p>
      ) : null}
    </section>
  );
}

/** Answers with the same command as the thread's composer; free-text questions stay in the thread. */
function DecisionQuestion({
  threadRef,
  prompt,
}: {
  threadRef: ScopedThreadRef;
  prompt: PendingUserInput;
}) {
  const gt = useGT();
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [edits, setEdits] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = seedUserInputDraftAnswers(prompt.questions, edits);
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);

  if (prompt.questions.some((question) => question.options.length === 0)) {
    return (
      <p className="text-muted-foreground text-sm">
        {gt("This question needs a written answer. Answer it in the thread.")}
      </p>
    );
  }

  const run = async (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (!canRespond || responding) return;
    setResponding(true);
    setError(null);
    const result = await send();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Failed to submit user input."));
    }
    setResponding(false);
  };

  const advance = () => {
    if (!progress.canAdvance) return;
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
    if (resolved === null) return;
    void run(() =>
      respond({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId: prompt.requestId, answers: resolved },
      }),
    );
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      {/* Digit shortcuts belong to the open thread's composer, not to these cards. */}
      <BackgroundThreadContext value>
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd={undefined}
          threadRef={threadRef}
          disabled={!canRespond}
          respondingRequestIds={responding ? [prompt.requestId] : []}
          answers={answers}
          questionIndex={progress.questionIndex}
          onToggleOption={(questionId, optionValue) => {
            const question = prompt.questions.find((entry) => entry.id === questionId);
            if (!question) return;
            setEdits((current) => ({
              ...current,
              [questionId]: togglePendingUserInputOptionSelection(
                question,
                current[questionId],
                optionValue,
              ),
            }));
          }}
          onAdvance={advance}
          onDismiss={(requestId: RuntimeRequestId) =>
            void run(() =>
              dismiss({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, requestId },
              }),
            )
          }
        />
      </BackgroundThreadContext>
      {progress.activeQuestion?.multiSelect ? (
        <div className="flex justify-end px-4 pb-3">
          <Button
            size="sm"
            disabled={!canRespond || responding || !progress.canAdvance}
            onClick={advance}
          >
            {progress.isLastQuestion
              ? gt("Send answer")
              : gt("Next", { $context: "button, goes to the next question" })}
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="px-4 pb-3 text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
