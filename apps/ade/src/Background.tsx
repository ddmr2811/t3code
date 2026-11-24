import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { Toggle, ToggleGroup, ToggleIcon } from "@ui-sdk/react/toggle";
import { type ChangeEvent, useRef, useState } from "react";

import { cn } from "./ui/utils.ts";

export type BackgroundMode = "luna" | "imagen" | "liso";

export interface BackgroundPreference {
  mode: BackgroundMode;
  color: boolean;
}

const MODE_KEY = "ade.background";
const COLOR_KEY = "ade.background.color";
const DEFAULT_PREFERENCE: BackgroundPreference = { mode: "luna", color: false };

const isBackgroundMode = (value: unknown): value is BackgroundMode =>
  value === "luna" || value === "imagen" || value === "liso";

export function readBackgroundPreference(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): BackgroundPreference {
  try {
    const rawMode = storage?.getItem(MODE_KEY);
    const rawColor = storage?.getItem(COLOR_KEY);
    return {
      mode: isBackgroundMode(rawMode) ? rawMode : DEFAULT_PREFERENCE.mode,
      color: rawColor === "1",
    };
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function writeBackgroundPreference(
  next: BackgroundPreference,
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): void {
  try {
    storage?.setItem(MODE_KEY, next.mode);
    storage?.setItem(COLOR_KEY, next.color ? "1" : "0");
  } catch {
    // Storage may be unavailable or full in private browsing; keep the choice in memory.
  }
}

const pillItemClass =
  "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-pressed:bg-white/15 data-pressed:font-medium data-pressed:text-foreground";

export function AdeBackground() {
  const [pref, setPref] = useState<BackgroundPreference>(() => readBackgroundPreference());
  const [customImage, setCustomImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updatePref = (next: BackgroundPreference) => {
    setPref(next);
    writeBackgroundPreference(next);
  };

  const onModeChange = (values: ReadonlyArray<string>) => {
    const chosen = values[0];
    if (!isBackgroundMode(chosen)) return;
    updatePref({ ...pref, mode: chosen });
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    // A data URL lives in memory; past ~10 MB it costs more than a background is worth.
    if (!file || file.size > 10 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/")) {
        setCustomImage(reader.result);
        updatePref({ ...pref, mode: "imagen" });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <div
        aria-hidden="true"
        data-ade-bg={pref.mode}
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      >
        {pref.mode === "luna" ? <div className="ade-bg-moon absolute inset-0" /> : null}
        {pref.mode === "imagen" ? (
          customImage !== null ? (
            <img
              src={customImage}
              alt=""
              className={cn(
                "size-full object-cover opacity-25 transition-[filter] duration-300 motion-reduce:transition-none",
                pref.color ? "brightness-55 saturate-90" : "grayscale brightness-50 contrast-105",
              )}
            />
          ) : (
            <div
              className={cn(
                "ade-bg-image-default absolute inset-0 opacity-28 transition-[filter] duration-300 motion-reduce:transition-none",
                pref.color ? "brightness-75" : "grayscale brightness-60",
              )}
            />
          )
        ) : null}
      </div>

      <div
        className="fixed right-4 bottom-3 z-10 flex items-center rounded-full border border-border bg-[rgb(12_13_16/0.92)] p-[3px] shadow-[0_10px_30px_rgb(0_0_0/0.6)] backdrop-blur-md max-[720px]:hidden"
        data-ade-bg-picker=""
      >
        <span
          aria-hidden="true"
          className="px-2.5 font-mono text-[10px] tracking-[0.09em] text-[var(--ade-text-tertiary)] max-[1440px]:hidden"
        >
          FONDO
        </span>
        <ToggleGroup
          value={[pref.mode]}
          deselectable={false}
          onValueChange={onModeChange}
          aria-label="Fondo"
          className="flex items-center gap-0.5"
        >
          <Toggle value="luna" className={pillItemClass}>
            <ToggleIcon>
              <MoonIcon size={14} />
            </ToggleIcon>
            Luna
          </Toggle>
          <Toggle value="imagen" className={pillItemClass}>
            <ToggleIcon>
              <ImageIcon size={14} />
            </ToggleIcon>
            Imagen
          </Toggle>
          <Toggle value="liso" className={pillItemClass}>
            Liso
          </Toggle>
        </ToggleGroup>

        {pref.mode === "imagen" ? (
          <div className="ml-1 flex items-center gap-0.5 border-l border-border pl-1">
            <Toggle
              pressed={pref.color}
              onPressedChange={(color) => updatePref({ ...pref, color })}
              className={pillItemClass}
            >
              <ToggleIcon>
                <PaletteIcon size={14} />
              </ToggleIcon>
              Color
            </Toggle>
            <button
              type="button"
              aria-label="Usar una imagen tuya"
              onClick={() => fileInputRef.current?.click()}
              className={cn(pillItemClass, "px-2")}
            >
              <UploadSimpleIcon size={14} aria-hidden />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              tabIndex={-1}
              className="ade-sr-only"
              onChange={onFileChange}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
