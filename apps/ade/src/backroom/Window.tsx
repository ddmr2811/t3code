import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { ReactNode } from "react";

// Adaptado de AppWindow.tsx de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9), MIT,
// © 2026 Adrián Alonso. Ver ./NOTICE. Sin el riel de iconos: la barra lateral del ADE ya navega.
/** Backroom's product window around a screen: its bar with the crumbs, then the panel. */
export function Window(props: {
  /** The screen's crumb; with `current`, it is the way back to it. */
  crumb: string;
  current?: string;
  onBack?: () => void;
  actions?: ReactNode;
  labelledBy?: string;
  label?: string;
  className: string;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`${props.className} br br-screen`}
      aria-labelledby={props.labelledBy}
      aria-label={props.label}
    >
      <div className="v4-window br-window" data-flush={props.flush ? "" : undefined}>
        <div className="v4-body">
          <div className="v4-bar">
            <span className="v4-crumbs">
              <span data-current={props.current === undefined || undefined}>
                {props.onBack === undefined ? (
                  props.crumb
                ) : (
                  <button type="button" className="br-crumb" onClick={props.onBack}>
                    <ArrowLeftIcon size={13} aria-hidden />
                    {props.crumb}
                  </button>
                )}
              </span>
              {props.current === undefined ? null : (
                <span data-current>
                  <CaretRightIcon size={13} aria-hidden />
                  {props.current}
                </span>
              )}
            </span>
            {props.actions === undefined ? null : (
              <span className="v4-bar-actions">{props.actions}</span>
            )}
          </div>
          <div className="v4-panel">{props.children}</div>
        </div>
      </div>
    </section>
  );
}
