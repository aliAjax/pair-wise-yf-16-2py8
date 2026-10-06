import {
  FIELD_LABELS,
  MERGE_FIELDS,
  type EntityKind,
  type FieldConflict,
  type Ledger,
  type MergeResult,
  type Operation,
} from "./types";
import { metaKey } from "./ids";

type EntityMap = Record<string, Record<string, unknown>>;

function clone<T>(v: T): T {
  return structuredClone(v);
}

const KIND_PLURAL: Record<EntityKind, "orders" | "damages" | "repairs"> = {
  order: "orders",
  damage: "damages",
  repair: "repairs",
};

/**
 * 字段级三方合并：
 * - 以 synced 基线为 base，本地为 local，对端为 remote
 * - 仅一方改过的字段直接采用；两方都改且不一致 → 进冲突队列，各留一版待确认
 * - 新增/删除按实体级处理；删除与改动冲突时进冲突队列
 */
export function mergeLedgers(local: Ledger, remote: Ledger): MergeResult {
  const merged = clone(local);
  const conflicts: FieldConflict[] = [];
  let changedCount = 0;

  const kinds: EntityKind[] = ["order", "damage", "repair"];
  for (const kind of kinds) {
    const key = KIND_PLURAL[kind];
    const localMap = local[key] as unknown as EntityMap;
    const remoteMap = remote[key] as unknown as EntityMap;
    const baseMap = (local.synced?.[key] ?? {}) as unknown as EntityMap;
    const mergedMap = merged[key] as unknown as EntityMap;
    const fields = MERGE_FIELDS[kind];

    const ids = new Set([...Object.keys(localMap), ...Object.keys(remoteMap), ...Object.keys(baseMap)]);
    for (const id of ids) {
      const base = baseMap[id];
      const l = localMap[id];
      const r = remoteMap[id];

      if (!l && !r) continue;

      // 两边都删除
      if (!l && !r) {
        delete mergedMap[id];
        continue;
      }

      // 仅对端有（新增）
      if (!l && r) {
        if (!base) {
          mergedMap[id] = clone(r);
          changedCount++;
        } else {
          // 本地删除、对端保留 → 冲突
          conflicts.push(existenceConflict(kind, id, base, "本地删除", "对端保留修改", local, remote));
        }
        continue;
      }

      // 仅本地有
      if (l && !r) {
        if (!base) {
          // 本地新增，对端没有 → 保留本地
          mergedMap[id] = clone(l);
        } else {
          // 对端删除、本地改动 → 冲突
          conflicts.push(existenceConflict(kind, id, base, "本地保留修改", "对端删除", local, remote));
        }
        continue;
      }

      // 两边都有实体
      if (!base) {
        // 两边都新增：逐字段合并，不一致进冲突
        const out = clone(l);
        for (const f of fields) {
          const lv = (l as Record<string, unknown>)[f];
          const rv = (r as Record<string, unknown>)[f];
          if (lv === rv) {
            (out as Record<string, unknown>)[f] = lv;
          } else {
            (out as Record<string, unknown>)[f] = lv;
            conflicts.push(
              fieldConflict(kind, id, f, "", String(lv ?? ""), String(rv ?? ""), local, remote),
            );
          }
        }
        mergedMap[id] = out;
        changedCount++;
        continue;
      }

      // 三方都有：逐字段合并
      const out = clone(l);
      let entityChanged = false;
      for (const f of fields) {
        const bv = (base as Record<string, unknown>)[f];
        const lv = (l as Record<string, unknown>)[f];
        const rv = (r as Record<string, unknown>)[f];
        const lChanged = lv !== bv;
        const rChanged = rv !== bv;
        if (lChanged && rChanged) {
          if (lv === rv) {
            (out as Record<string, unknown>)[f] = lv;
          } else {
            (out as Record<string, unknown>)[f] = lv;
            conflicts.push(
              fieldConflict(kind, id, f, String(bv ?? ""), String(lv ?? ""), String(rv ?? ""), local, remote),
            );
            entityChanged = true;
          }
        } else if (rChanged) {
          (out as Record<string, unknown>)[f] = rv;
          entityChanged = true;
        } else {
          (out as Record<string, unknown>)[f] = lv;
        }
      }
      // 实体元数据：版本取较大，更新时间取较新
      const lo = l as Record<string, unknown>;
      const ro = r as Record<string, unknown>;
      if (typeof lo.version === "number" && typeof ro.version === "number") {
        (out as Record<string, unknown>).version = Math.max(lo.version, ro.version);
      }
      if (typeof lo.updatedAt === "number" && typeof ro.updatedAt === "number") {
        (out as Record<string, unknown>).updatedAt = Math.max(lo.updatedAt, ro.updatedAt);
        (out as Record<string, unknown>).updatedBy =
          (lo.updatedAt as number) >= (ro.updatedAt as number) ? lo.updatedBy : ro.updatedBy;
      }
      if (entityChanged) changedCount++;
      mergedMap[id] = out;
    }
  }

  // 字段级时间戳：取较新者
  merged.fieldMeta = mergeFieldMeta(local.fieldMeta, remote.fieldMeta);

  // 修补确认时记录的损伤版本取较大者，避免按旧版本误作废
  for (const [id, r] of Object.entries(merged.repairs)) {
    const l = local.repairs[id];
    const rr = remote.repairs[id];
    if (l && rr) {
      const lv = l.confirmedDamageVersion ?? 0;
      const rv = rr.confirmedDamageVersion ?? 0;
      if (lv > 0 || rv > 0) r.confirmedDamageVersion = Math.max(lv, rv);
    }
  }

  // 合并后的状态成为新的同步基线
  merged.synced = {
    orders: clone(merged.orders),
    damages: clone(merged.damages),
    repairs: clone(merged.repairs),
  };

  // 冲突队列：保留未解决的旧冲突，追加新冲突
  merged.conflicts = [...(local.conflicts ?? []).filter((c) => !conflicts.some((n) => n.id === c.id)), ...conflicts];

  return { merged, conflicts, changedCount };
}

function fieldConflict(
  kind: EntityKind,
  entityId: string,
  field: string,
  base: string,
  local: string,
  remote: string,
  localLedger: Ledger,
  remoteLedger: Ledger,
): FieldConflict {
  const lm = localLedger.fieldMeta?.[metaKey(kind, entityId, field)];
  const rm = remoteLedger.fieldMeta?.[metaKey(kind, entityId, field)];
  return {
    id: `CF-${kind}-${entityId}-${field}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    entityId,
    field,
    label: FIELD_LABELS[field] ?? field,
    base,
    local,
    remote,
    localAt: lm?.at ?? 0,
    remoteAt: rm?.at ?? 0,
    createdAt: Date.now(),
  };
}

function existenceConflict(
  kind: EntityKind,
  entityId: string,
  _base: unknown,
  local: string,
  remote: string,
  localLedger: Ledger,
  remoteLedger: Ledger,
): FieldConflict {
  const lm = localLedger.fieldMeta?.[metaKey(kind, entityId, "status")];
  const rm = remoteLedger.fieldMeta?.[metaKey(kind, entityId, "status")];
  return {
    id: `CF-${kind}-${entityId}-existence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    entityId,
    field: "existence",
    label: "整条记录",
    base: "",
    local,
    remote,
    localAt: lm?.at ?? 0,
    remoteAt: rm?.at ?? 0,
    createdAt: Date.now(),
  };
}

function mergeFieldMeta(
  a: Record<string, { at: number; by: string }>,
  b: Record<string, { at: number; by: string }>,
): Record<string, { at: number; by: string }> {
  const out: Record<string, { at: number; by: string }> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (!cur || v.at > cur.at) out[k] = v;
  }
  return out;
}

/** 对比两个台账，生成差异操作（写盘失败时进 outbox 重试） */
export function diffToOps(before: Ledger, after: Ledger): Operation[] {
  const ops: Operation[] = [];
  const kinds: EntityKind[] = ["order", "damage", "repair"];
  for (const kind of kinds) {
    const key = KIND_PLURAL[kind];
    const beforeMap = before[key] as unknown as EntityMap;
    const afterMap = after[key] as unknown as EntityMap;
    const cap = kind[0].toUpperCase() + kind.slice(1);
    for (const [id, ent] of Object.entries(afterMap)) {
      if (!beforeMap[id] || JSON.stringify(beforeMap[id]) !== JSON.stringify(ent)) {
        ops.push({ op: `upsert${cap}`, entity: clone(ent) } as unknown as Operation);
      }
    }
    for (const id of Object.keys(beforeMap)) {
      if (!afterMap[id]) {
        ops.push({ op: `delete${cap}`, id } as unknown as Operation);
      }
    }
  }
  return ops;
}
