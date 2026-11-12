import type {
  EnvironmentId,
  ForkAuthorizeEvent,
  ForkExtensionAgent,
  ForkExtensionProblem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  forkExtensionsAuthorize,
  forkExtensionsAuthorizeComplete,
} from "../../state/forkExtensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CLAUDE_AI_CONNECTORS_URL,
  FORK_AGENT_LABELS,
  forkAuthorizeAction,
} from "./ForkExtensions.logic";
import {
  commandFailureProblem,
  ForkProblemText,
  type ForkDetailCellContext,
  type ForkNotice,
} from "./ForkExtensionsDetail";

/** One login: which server, on which machine and agent. */
export interface ForkAuthorizeTarget {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly agent: ForkExtensionAgent;
  readonly itemId: string;
  readonly itemName: string;
}

type AuthorizeStep =
  | { readonly tag: "starting" }
  | {
      readonly tag: "paste";
      readonly sessionId: string;
      readonly url: string;
      readonly finishing: boolean;
      /** Why the last pasted address was refused; the login is still waiting. */
      readonly problem: ForkExtensionProblem | null;
    }
  | { readonly tag: "failed"; readonly problem: ForkExtensionProblem };

interface AuthorizeDialogState {
  readonly open: boolean;
  readonly target: ForkAuthorizeTarget;
  readonly step: AuthorizeStep;
}

const LOGIN_ENDED: ForkExtensionProblem = {
  reason: "commandFailed",
  summary: "The login ended before it finished.",
  nextStep: "Click Authorize to start again.",
  rawOutput: null,
};

/** The app's way of opening an external page (desktop shell, or a new tab in a browser). */
function openInBrowser(url: string): void {
  try {
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => {});
  } catch {
    // No local API: the dialog's "Open the sign-in page" link is still there.
  }
}

const placeLabel = (target: ForkAuthorizeTarget) =>
  `${target.machineLabel} · ${FORK_AGENT_LABELS[target.agent]}`;

/**
 * Runs "Authorize" (spec §6.7): the machine starts the login and sends its sign-in address, this
 * browser opens it, and the address the browser lands on is pasted back to finish the login on
 * that machine, also when it is a remote one. Cancelling or closing the dialog stops the login.
 */
export function useForkAuthorize(options: {
  readonly onNotices: (notices: ReadonlyArray<ForkNotice>) => void;
  /** After a login finished on that machine. */
  readonly onAuthorized: (environmentId: EnvironmentId) => void;
}): { readonly start: (target: ForkAuthorizeTarget) => void; readonly dialog: ReactNode } {
  // Failures show in the dialog, so no toast as well.
  const authorize = useAtomCommand(forkExtensionsAuthorize, { reportFailure: false });
  const complete = useAtomCommand(forkExtensionsAuthorizeComplete, { reportFailure: false });
  const [state, setState] = useState<AuthorizeDialogState | null>(null);
  const [address, setAddress] = useState("");
  // Answers from a login the dialog no longer shows are dropped by this counter.
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // Leaving the page while a login waits must stop it; otherwise the machine keeps the login's
  // terminal open until it times out.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the login stream (a connection to the machine) until unmount
  useEffect(() => () => controller.current?.abort(), []);

  const stop = () => {
    run.current += 1;
    controller.current?.abort();
    controller.current = null;
  };
  const close = () => {
    stop();
    setAddress("");
    setState((current) => (current === null ? null : { ...current, open: false }));
  };
  const setStep = (id: number, step: AuthorizeStep) => {
    if (id !== run.current) return;
    setState((current) => (current === null ? null : { ...current, step }));
  };

  const start = async (target: ForkAuthorizeTarget) => {
    stop();
    const id = run.current;
    const abort = new AbortController();
    controller.current = abort;
    setAddress("");
    setState({ open: true, target, step: { tag: "starting" } });

    const onEvent = (event: ForkAuthorizeEvent) => {
      if (id !== run.current) return;
      switch (event._tag) {
        case "authUrl":
          openInBrowser(event.url);
          setStep(id, {
            tag: "paste",
            sessionId: event.sessionId,
            url: event.url,
            finishing: false,
            problem: null,
          });
          return;
        case "done":
          run.current += 1;
          controller.current = null;
          setAddress("");
          setState((current) => (current === null ? null : { ...current, open: false }));
          options.onNotices([
            {
              key: `authorize:${target.itemId}\n${target.environmentId}:${target.agent}`,
              tone: "success",
              title: `Authorized ${target.itemName} on ${placeLabel(target)}`,
              problem: null,
            },
          ]);
          options.onAuthorized(target.environmentId);
          return;
        case "failed":
          setStep(id, { tag: "failed", problem: event.problem });
          return;
      }
    };

    const result = await authorize({
      environmentId: target.environmentId,
      input: {
        payload: { itemId: target.itemId, agent: target.agent },
        onEvent,
        signal: abort.signal,
      },
    });
    if (id !== run.current) return;
    controller.current = null;
    if (result._tag === "Failure") {
      const problem = commandFailureProblem(result);
      if (problem === null) close();
      else setStep(id, { tag: "failed", problem });
      return;
    }
    // `done` and `failed` were handled as they came; any other end left the login unfinished.
    const last = Option.getOrNull(result.value);
    if (last?._tag !== "failed") setStep(id, { tag: "failed", problem: LOGIN_ENDED });
  };

  const finish = async () => {
    if (state === null || state.step.tag !== "paste" || state.step.finishing) return;
    const redirectUrl = address.trim();
    if (redirectUrl === "") return;
    const id = run.current;
    const { target, step } = state;
    // The address carries the sign-in code: it leaves the input as soon as it is sent.
    setAddress("");
    setStep(id, { ...step, finishing: true, problem: null });
    const result = await complete({
      environmentId: target.environmentId,
      input: { sessionId: step.sessionId, redirectUrl },
    });
    if (id !== run.current || result._tag === "Success") return;
    // On success the login finishes on the machine and its stream sends `done`.
    const problem = commandFailureProblem(result);
    if (problem !== null) setStep(id, { ...step, finishing: false, problem });
  };

  // While pasting, the login waits on the machine: a stray click or Escape must not end it,
  // so only Cancel and the close button leave this step.
  const pasting = state?.step.tag === "paste";
  const dialog = (
    <Dialog
      open={state?.open ?? false}
      disablePointerDismissal={pasting}
      onOpenChange={(open, details) => {
        if (open) return;
        if (pasting && (details.reason === "escape-key" || details.reason === "outside-press")) {
          details.cancel();
          return;
        }
        close();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) setState((current) => (current?.open === true ? current : null));
      }}
    >
      {state === null ? null : (
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Authorize {state.target.itemName}</DialogTitle>
            <DialogDescription>On {placeLabel(state.target)}.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <AuthorizeStepBody
              state={state}
              address={address}
              onAddressChange={setAddress}
              onFinish={() => void finish()}
            />
          </DialogPanel>
          <DialogFooter>
            {state.step.tag === "failed" ? (
              <>
                <Button variant="outline" onClick={close}>
                  Close
                </Button>
                <Button onClick={() => void start(state.target)}>Try again</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
                {state.step.tag === "paste" ? (
                  <Button
                    type="submit"
                    form="fork-authorize-finish"
                    disabled={state.step.finishing || address.trim() === ""}
                  >
                    {state.step.finishing ? "Finishing…" : "Finish"}
                  </Button>
                ) : null}
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      )}
    </Dialog>
  );

  return { start: (target) => void start(target), dialog };
}

function AuthorizeStepBody({
  state: { target, step },
  address,
  onAddressChange,
  onFinish,
}: {
  readonly state: AuthorizeDialogState;
  readonly address: string;
  readonly onAddressChange: (address: string) => void;
  readonly onFinish: () => void;
}) {
  if (step.tag === "starting") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner className="size-3.5" />
        Starting the login on {target.machineLabel}…
      </p>
    );
  }
  if (step.tag === "failed") return <ForkProblemText problem={step.problem} />;
  return (
    <form
      id="fork-authorize-finish"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onFinish();
      }}
    >
      <p className="text-muted-foreground">
        The sign-in page opened in your browser. If it didn't,{" "}
        <button
          type="button"
          className="text-foreground underline underline-offset-2"
          onClick={() => openInBrowser(step.url)}
        >
          open the sign-in page
        </button>
        .
      </p>
      <p>
        After you approve, your browser lands on a page that may not load. Copy its full address and
        paste it here.
      </p>
      <Input
        aria-label="Address of the page your browser landed on"
        placeholder="http://localhost:…"
        autoComplete="off"
        spellCheck={false}
        inputMode="url"
        autoFocus
        value={address}
        disabled={step.finishing}
        onChange={(event) => onAddressChange(event.target.value)}
      />
      {step.finishing ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-3.5" />
          Finishing the login on {target.machineLabel}…
        </p>
      ) : null}
      {step.problem !== null ? <ForkProblemText problem={step.problem} /> : null}
    </form>
  );
}

/** "Authorize" under a detail cell whose server needs a sign-in. */
export function ForkAuthorizeButton({
  context: { column, cell, item },
  onLogin,
}: {
  readonly context: ForkDetailCellContext;
  readonly onLogin: (agent: ForkExtensionAgent) => void;
}) {
  const action = forkAuthorizeAction(column, cell, item);
  switch (action.kind) {
    case "none":
      return null;
    case "connector":
      return (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => openInBrowser(CLAUDE_AI_CONNECTORS_URL)}
        >
          Authorize on claude.ai
        </Button>
      );
    case "login":
      return (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => onLogin(action.agent)}
        >
          Authorize
        </Button>
      );
    case "disabled":
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                aria-disabled
                aria-description={action.reason}
              >
                Authorize
              </Button>
            }
          />
          <TooltipPopup>{action.reason}</TooltipPopup>
        </Tooltip>
      );
  }
}
