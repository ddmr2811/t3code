import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { SquareIcon } from "@phosphor-icons/react/dist/csr/Square";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { Toggle, ToggleGroup, ToggleIcon } from "@ui-sdk/react/toggle";
import { type ChangeEvent, useRef, useState } from "react";

import { cn } from "./ui/utils.ts";

export type BackgroundMode = "cielo" | "luna" | "imagen" | "liso";

export interface BackgroundPreference {
  mode: BackgroundMode;
  color: boolean;
}

const MODE_KEY = "ade.background";
const COLOR_KEY = "ade.background.color";
const DEFAULT_PREFERENCE: BackgroundPreference = { mode: "cielo", color: false };

const isBackgroundMode = (value: unknown): value is BackgroundMode =>
  value === "cielo" || value === "luna" || value === "imagen" || value === "liso";

export function readBackgroundPreference(storage?: Pick<Storage, "getItem">): BackgroundPreference {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const rawMode = store?.getItem(MODE_KEY);
    const rawColor = store?.getItem(COLOR_KEY);
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
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    store?.setItem(MODE_KEY, next.mode);
    store?.setItem(COLOR_KEY, next.color ? "1" : "0");
  } catch {
    // Storage may be unavailable or full in private browsing; keep the choice in memory.
  }
}

const iconToggleClass =
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-pressed:bg-white/15 data-pressed:text-foreground max-[720px]:size-11";

/** The chosen background and the user's own image; the image lives only for this session. */
export function useBackground() {
  const [pref, setPref] = useState<BackgroundPreference>(() => readBackgroundPreference());
  const [customImage, setCustomImage] = useState<string | null>(null);
  const update = (next: BackgroundPreference) => {
    setPref(next);
    writeBackgroundPreference(next);
  };
  return { pref, update, customImage, setCustomImage };
}

type Background = ReturnType<typeof useBackground>;

/** The static layer behind the whole app. */
export function BackgroundLayer({ pref, customImage }: Pick<Background, "pref" | "customImage">) {
  return (
    <div
      aria-hidden="true"
      data-ade-bg={pref.mode}
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {pref.mode === "cielo" ? <div className="br-sky absolute inset-0" /> : null}
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
  );
}

const MODE_ICON = {
  cielo: CloudIcon,
  luna: MoonIcon,
  imagen: ImageIcon,
  liso: SquareIcon,
} as const;

/** Icon-only picker in the sidebar footer, or inside a popover when the rail is collapsed. */
export function BackgroundPicker({
  pref,
  update,
  setCustomImage,
  compact = false,
}: Background & { compact?: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onModeChange = (values: ReadonlyArray<string>) => {
    const chosen = values[0];
    if (isBackgroundMode(chosen)) update({ ...pref, mode: chosen });
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
        update({ ...pref, mode: "imagen" });
      }
    };
    reader.readAsDataURL(file);
  };

  const controls = (
    <div className="flex items-center gap-0.5">
      <ToggleGroup
        value={[pref.mode]}
        deselectable={false}
        onValueChange={onModeChange}
        aria-label="Fondo"
        className="flex items-center gap-0.5"
      >
        <Toggle value="cielo" aria-label="Fondo: cielo" className={iconToggleClass}>
          <ToggleIcon>
            <CloudIcon size={14} />
          </ToggleIcon>
        </Toggle>
        <Toggle value="luna" aria-label="Fondo: luna" className={iconToggleClass}>
          <ToggleIcon>
            <MoonIcon size={14} />
          </ToggleIcon>
        </Toggle>
        <Toggle value="imagen" aria-label="Fondo: imagen" className={iconToggleClass}>
          <ToggleIcon>
            <ImageIcon size={14} />
          </ToggleIcon>
        </Toggle>
        <Toggle value="liso" aria-label="Fondo: liso" className={iconToggleClass}>
          <ToggleIcon>
            <SquareIcon size={14} />
          </ToggleIcon>
        </Toggle>
      </ToggleGroup>
      {pref.mode === "imagen" ? (
        <>
          <Toggle
            pressed={pref.color}
            onPressedChange={(color) => update({ ...pref, color })}
            aria-label="Imagen en color"
            className={iconToggleClass}
          >
            <ToggleIcon>
              <PaletteIcon size={14} />
            </ToggleIcon>
          </Toggle>
          <button
            type="button"
            aria-label="Usar una imagen tuya"
            onClick={() => fileInputRef.current?.click()}
            className={iconToggleClass}
          >
            <UploadSimpleIcon size={14} aria-hidden />
          </button>
        </>
      ) : null}
    </div>
  );

  // Kept outside the popover so closing the menu while the OS file dialog is open still delivers onChange.
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      tabIndex={-1}
      className="ade-sr-only"
      onChange={onFileChange}
    />
  );

  if (compact) {
    const ActiveIcon = MODE_ICON[pref.mode];
    return (
      <>
        <Popover>
          <PopoverTrigger className="ade-rail-button" aria-label="Fondo">
            <ActiveIcon size={18} aria-hidden />
          </PopoverTrigger>
          <PopoverContent side="right" align="end" sideOffset={10} className="ade-bg-popover">
            <PopoverTitle className="ade-bg-popover-title">Fondo</PopoverTitle>
            {controls}
          </PopoverContent>
        </Popover>
        {fileInput}
      </>
    );
  }

  return (
    <div className="ml-auto flex items-center gap-0.5">
      {controls}
      {fileInput}
    </div>
  );
}
