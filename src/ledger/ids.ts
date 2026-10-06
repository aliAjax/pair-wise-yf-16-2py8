import type { EntityKind } from "./types";

/** 生成稳定编号：DMG-0001 / REP-0001 / WO-0001，编号一经分配不再随内容改动 */
export function nextId(seq: number, kind: EntityKind): { id: string; seq: number } {
  const prefix = kind === "damage" ? "DMG" : kind === "repair" ? "REP" : "WO";
  const next = seq + 1;
  return { id: `${prefix}-${String(next).padStart(4, "0")}`, seq: next };
}

export function now(): number {
  return Date.now();
}

export function metaKey(kind: EntityKind, id: string, field: string): string {
  return `${kind}:${id}:${field}`;
}

export function formatTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
