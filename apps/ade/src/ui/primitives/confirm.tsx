import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
} from "@ui-sdk/react/alert-dialog";
import { useState } from "react";

export interface ConfirmQuestion {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

/** One confirm dialog per view; `ask` resolves true when the person agrees. */
export function useConfirm() {
  const [confirm] = useState(() => createConfirm<ConfirmQuestion>());
  const dialog = (
    <AlertDialog controller={confirm.controller}>
      <AlertDialogBackdrop className="fixed inset-0 bg-black/70" />
      <AlertDialogContent<ConfirmQuestion> className="fixed inset-0 m-auto grid h-fit w-[min(420px,calc(100vw-32px))] gap-3 rounded-lg border border-border bg-card p-4 text-foreground">
        {(state) => (
          <>
            <AlertDialogTitle className="m-0 text-base font-semibold">
              {state.payload?.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="m-0 text-[13px] break-words text-muted-foreground">
              {state.payload?.description}
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <AlertDialogClose className="ade-button-quiet m-0!">Cancelar</AlertDialogClose>
              <AlertDialogClose className="ade-button" value="confirm">
                {state.payload?.confirmLabel}
              </AlertDialogClose>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
  return { ask: confirm, dialog };
}
