import type { ForkBot, ForkMemoryNote, ForkMemoryPrevious, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Essentials oldest first, as the coordinator receives them; the rest newest first. */
export function memorySections(notes: ReadonlyArray<ForkMemoryNote>) {
  return {
    essential: notes
      .filter((note) => note.inclusion === "essential")
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    searchable: notes
      .filter((note) => note.inclusion === "searchable")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}

export interface MemoryChange {
  readonly before: ForkMemoryNote | null;
  readonly after: ForkMemoryNote | null;
}

/** What differs between the kept version and now: a merged note reads as one gone and one new. */
export function memoryChanges(
  previous: ReadonlyArray<ForkMemoryNote>,
  current: ReadonlyArray<ForkMemoryNote>,
): ReadonlyArray<MemoryChange> {
  const now = new Map(current.map((note) => [note.id, note]));
  const then = new Map(previous.map((note) => [note.id, note]));
  const changes: MemoryChange[] = [];
  for (const before of previous) {
    const after = now.get(before.id) ?? null;
    if (after === null) changes.push({ before, after: null });
    else if (after.text !== before.text || after.inclusion !== before.inclusion) {
      changes.push({ before, after });
    }
  }
  for (const after of current) if (!then.has(after.id)) changes.push({ before: null, after });
  return changes;
}

export interface MemoryReader {
  readonly bot: ForkBot;
  readonly reads: string;
}

/** The project's live bots, coordinator first, with what each gets from the memory. */
export function memoryReaders(
  bots: ReadonlyArray<ForkBot>,
  projectId: ProjectId,
  essentialCount: number,
): ReadonlyArray<MemoryReader> {
  return bots
    .filter((bot) => bot.projectId === projectId && !bot.archived)
    .toSorted(
      (a, b) => Number(b.coordinator) - Number(a.coordinator) || a.name.localeCompare(b.name),
    )
    .map((bot) => ({
      bot,
      reads: !bot.coordinator
        ? "Busca en ella cuando le hace falta"
        : essentialCount === 0
          ? "La consulta al empezar cada tarea"
          : `Recibe ${essentialCount === 1 ? "la esencial" : `las ${essentialCount} esenciales`} y busca el resto`,
    }));
}

const DAY = 86_400_000;

/** «hace 3 días», or the date once it is a month old. */
export function memoryAge(iso: string, nowMs: number): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  const ms = DateTime.toEpochMillis(parsed.value);
  const minutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor((nowMs - ms) / DAY);
  if (days < 30) return days === 1 ? "ayer" : `hace ${days} días`;
  return DateTime.formatLocal(parsed.value, { locale: "es-ES", day: "numeric", month: "short" });
}

export function previousLabel(previous: ForkMemoryPrevious): string {
  return previous.reason === "correction" && previous.correction !== undefined
    ? `Antes de «${previous.correction}»`
    : "La que había antes de volver atrás";
}
