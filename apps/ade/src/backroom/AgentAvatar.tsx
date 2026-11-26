// Adaptado de AgentAvatar.tsx de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9), MIT,
// © 2026 Adrián Alonso. Ver ./NOTICE.
import { Mascot, type MascotKind } from "./Mascot.tsx";

const AVATAR_CLASS: Record<MascotKind, string> = {
  orbit: "avatar-clara",
  spark: "avatar-vega",
  maker: "avatar-nico",
};

/** The coordinator wears Clara's mascot; every other bot keeps one of the other two by its handle. */
export function botMascot(bot: { readonly handle: string; readonly coordinator: boolean }) {
  if (bot.coordinator) return "orbit";
  let sum = 0;
  for (const char of bot.handle) sum += char.charCodeAt(0);
  return sum % 2 === 0 ? "spark" : "maker";
}

export function AgentAvatar(props: { kind: MascotKind; className?: string }) {
  return (
    <span
      className={`agent-avatar ${AVATAR_CLASS[props.kind]} ${props.className ?? ""}`}
      aria-hidden
    >
      <Mascot kind={props.kind} />
    </span>
  );
}
