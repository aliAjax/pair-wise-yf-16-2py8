import { useSyncExternalStore } from "react";
import {
  SCHEMA_VERSION,
  type DamagePoint,
  type FieldConflict,
  type Ledger,
  type Operation,
  type RepairRecord,
  type WorkOrder,
} from "./types";
import { metaKey, nextId } from "./ids";
import { migrate } from "./migrate";
import { diffToOps, mergeLedgers } from "./merge";
import { recomputeValidity, invalidateMaterialChanges } from "./validity";

const STORAGE_KEY = "ski-tuning-ledger-v1";
const FAULT_KEY = "ski-tuning-ledger-fault";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function emptySynced(): Ledger["synced"] {
  return { orders: {}, damages: {}, repairs: {} };
}

/** 把未提交批次的操作重放到台账（刷新后留住未保存的改动） */
function replayOutbox(ledger: Ledger): Ledger {
  const draft = clone(ledger);
  for (const batch of draft.outbox) {
    for (const op of batch.ops) {
      applyOp(draft, op);
    }
  }
  recomputeValidity(draft);
  return draft;
}

function applyOp(ledger: Ledger, op: Operation): void {
  switch (op.op) {
    case "upsertOrder":
      ledger.orders[op.entity.id] = clone(op.entity);
      break;
    case "deleteOrder":
      delete ledger.orders[op.id];
      break;
    case "upsertDamage":
      ledger.damages[op.entity.id] = clone(op.entity);
      break;
    case "deleteDamage":
      delete ledger.damages[op.id];
      break;
    case "upsertRepair":
      ledger.repairs[op.entity.id] = clone(op.entity);
      break;
    case "deleteRepair":
      delete ledger.repairs[op.id];
      break;
  }
}

function loadFromDisk(): Ledger {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ledger = migrate(raw ? JSON.parse(raw) : null);
    return replayOutbox(ledger);
  } catch (e) {
    console.error("台账读取失败", e);
    return migrate(null);
  }
}

class LedgerStore {
  private state: Ledger;
  private listeners = new Set<() => void>();
  private faultInjection = false;

  constructor() {
    this.state = loadFromDisk();
    this.faultInjection = localStorage.getItem(FAULT_KEY) === "1";
    // 启动时尝试把重放后的批次写盘
    void this.persist([]);
  }

  getState = (): Ledger => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** 写盘：失败则把批次留在 outbox 待重试 */
  private async persist(ops: Operation[], label = "本地改动"): Promise<boolean> {
    try {
      if (this.faultInjection) throw new Error("模拟写盘失败（写盘开关打开）");
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      if (this.state.outbox.length > 0) {
        const draft = clone(this.state);
        draft.outbox = [];
        this.state = draft;
        this.emit();
      }
      return true;
    } catch (e) {
      const draft = clone(this.state);
      draft.outbox.push({
        id: `BATCH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: Date.now(),
        attempts: 1,
        label,
        ops,
        error: e instanceof Error ? e.message : String(e),
      });
      this.state = draft;
      this.emit();
      return false;
    }
  }

  /** 重试 outbox 中的未提交批次 */
  async retryBatch(batchId: string): Promise<void> {
    const ok = await this.persist([], "重试批次");
    if (!ok) {
      const draft = clone(this.state);
      const batch = draft.outbox.find((b) => b.id === batchId);
      if (batch) {
        batch.attempts += 1;
        batch.error = "重试仍失败";
      }
      this.state = draft;
      this.emit();
    }
  }

  async retryAll(): Promise<void> {
    await this.persist([], "全部重试");
  }

  setFaultInjection(on: boolean): void {
    this.faultInjection = on;
    localStorage.setItem(FAULT_KEY, on ? "1" : "0");
    this.emit();
    if (!on) void this.retryAll();
  }

  isFaultInjection(): boolean {
    return this.faultInjection;
  }

  /** 本地改动入口：更新内存态 → 作废重算 → 尝试写盘 */
  private commit(
    updater: (draft: Ledger) => void,
    ops: Operation[],
    label: string,
  ): void {
    const draft = clone(this.state);
    updater(draft);
    recomputeValidity(draft);
    this.state = draft;
    this.emit();
    void this.persist(ops, label);
  }

  // ---- 工单 ----

  upsertOrder(input: WorkOrder): void {
    const now = Date.now();
    const entity: WorkOrder = {
      ...input,
      version: input.version + 1,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertOrder", entity }];
    this.commit(
      (draft) => {
        draft.orders[entity.id] = entity;
        for (const f of ["boardBrand", "boardLength", "boardType", "edgeAngle", "waxType", "customerPref", "status"]) {
          draft.fieldMeta[metaKey("order", entity.id, f)] = { at: now, by: this.state.deviceId };
        }
      },
      ops,
      `保存工单 ${entity.id}`,
    );
  }

  addOrder(): string {
    const now = Date.now();
    const id = `ORD-${String(Object.keys(this.state.orders).length + 101).padStart(3, "0")}`;
    const entity: WorkOrder = {
      id,
      boardBrand: "",
      boardLength: "",
      boardType: "",
      edgeAngle: "",
      waxType: "",
      customerPref: "",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertOrder", entity }];
    this.commit(
      (draft) => {
        draft.orders[id] = entity;
        for (const f of ["boardBrand", "boardLength", "boardType", "edgeAngle", "waxType", "customerPref", "status"]) {
          draft.fieldMeta[metaKey("order", id, f)] = { at: now, by: this.state.deviceId };
        }
      },
      ops,
      `新增工单 ${id}`,
    );
    return id;
  }

  // ---- 损伤点 ----

  upsertDamage(input: DamagePoint): void {
    const now = Date.now();
    const existing = this.state.damages[input.id];
    const entity: DamagePoint = {
      ...input,
      version: input.version + 1,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertDamage", entity }];
    this.commit(
      (draft) => {
        draft.damages[entity.id] = entity;
        for (const f of ["location", "kind", "size", "note"]) {
          draft.fieldMeta[metaKey("damage", entity.id, f)] = { at: now, by: this.state.deviceId };
        }
        // 损伤点核心字段改动 → 关联已确认修补立即作废
        if (
          existing &&
          (existing.location !== entity.location ||
            existing.kind !== entity.kind ||
            existing.size !== entity.size)
        ) {
          for (const r of Object.values(draft.repairs)) {
            if (r.damageId === entity.id && r.confirmed) {
              r.confirmed = false;
              r.invalid = true;
              r.invalidReason = "损伤点位置/类型/尺寸有改动";
              r.invalidatedAt = now;
              ops.push({ op: "upsertRepair", entity: clone(r) });
            }
          }
        }
      },
      ops,
      `保存损伤点 ${entity.id}`,
    );
  }

  addDamage(orderId: string): string {
    const now = Date.now();
    const { id, seq } = nextId(this.state.seq, "damage");
    const entity: DamagePoint = {
      id,
      orderId,
      location: "",
      kind: "划痕",
      size: "",
      note: "",
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertDamage", entity }];
    this.commit(
      (draft) => {
        draft.seq = seq;
        draft.damages[id] = entity;
        for (const f of ["location", "kind", "size", "note"]) {
          draft.fieldMeta[metaKey("damage", id, f)] = { at: now, by: this.state.deviceId };
        }
      },
      ops,
      `新增损伤点 ${id}`,
    );
    return id;
  }

  // ---- 修补记录 ----

  upsertRepair(input: RepairRecord): void {
    const now = Date.now();
    const existing = this.state.repairs[input.id];
    const entity: RepairRecord = {
      ...input,
      version: input.version + 1,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertRepair", entity }];
    this.commit(
      (draft) => {
        draft.repairs[entity.id] = entity;
        for (const f of ["damageId", "material", "method", "result", "confirmed"]) {
          draft.fieldMeta[metaKey("repair", entity.id, f)] = { at: now, by: this.state.deviceId };
        }
        // 修补材料改动 → 已确认修补立即作废
        if (existing && existing.material !== entity.material && existing.confirmed) {
          entity.confirmed = false;
          entity.invalid = true;
          entity.invalidReason = "修补材料有改动";
          entity.invalidatedAt = now;
        }
      },
      ops,
      `保存修补记录 ${entity.id}`,
    );
  }

  addRepair(orderId: string, damageId: string): string {
    const now = Date.now();
    const { id, seq } = nextId(this.state.seq, "repair");
    const damage = this.state.damages[damageId];
    const entity: RepairRecord = {
      id,
      orderId,
      damageId,
      damageLocation: damage?.location ?? "",
      material: "P-Tex",
      method: "",
      result: "",
      confirmed: false,
      invalid: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertRepair", entity }];
    this.commit(
      (draft) => {
        draft.seq = seq;
        draft.repairs[id] = entity;
        for (const f of ["damageId", "material", "method", "result", "confirmed"]) {
          draft.fieldMeta[metaKey("repair", id, f)] = { at: now, by: this.state.deviceId };
        }
      },
      ops,
      `新增修补记录 ${id}`,
    );
    return id;
  }

  confirmRepair(repairId: string, confirmed: boolean): void {
    const existing = this.state.repairs[repairId];
    if (!existing) return;
    const now = Date.now();
    const damage = this.state.damages[existing.damageId];
    const entity: RepairRecord = {
      ...existing,
      confirmed,
      invalid: confirmed ? false : existing.invalid,
      invalidReason: confirmed ? undefined : existing.invalidReason,
      confirmedAt: confirmed ? now : existing.confirmedAt,
      confirmedDamageVersion: confirmed ? damage?.version : existing.confirmedDamageVersion,
      version: existing.version + 1,
      updatedAt: now,
      updatedBy: this.state.deviceId,
    };
    const ops: Operation[] = [{ op: "upsertRepair", entity }];
    this.commit(
      (draft) => {
        draft.repairs[repairId] = entity;
        draft.fieldMeta[metaKey("repair", repairId, "confirmed")] = { at: now, by: this.state.deviceId };
      },
      ops,
      `${confirmed ? "确认" : "取消确认"}修补 ${repairId}`,
    );
  }

  /** 删除损伤点：关联修补保留并标记作废（损伤点已删，历史位置快照仍可查） */
  commitDeleteDamage(id: string): void {
    const now = Date.now();
    const ops: Operation[] = [{ op: "deleteDamage", id }];
    this.commit(
      (draft) => {
        delete draft.damages[id];
        for (const r of Object.values(draft.repairs)) {
          if (r.damageId === id) {
            r.confirmed = false;
            r.invalid = true;
            r.invalidReason = "关联损伤点已删除";
            r.invalidatedAt = now;
            ops.push({ op: "upsertRepair", entity: clone(r) });
          }
        }
      },
      ops,
      `删除损伤点 ${id}`,
    );
  }

  commitDeleteRepair(id: string): void {
    this.commit(
      (draft) => {
        delete draft.repairs[id];
      },
      [{ op: "deleteRepair", id }],
      `删除修补记录 ${id}`,
    );
  }

  commitDeleteOrder(id: string): void {
    const ops: Operation[] = [{ op: "deleteOrder", id }];
    this.commit(
      (draft) => {
        delete draft.orders[id];
        for (const d of Object.values(draft.damages)) {
          if (d.orderId === id) {
            delete draft.damages[d.id];
            ops.push({ op: "deleteDamage", id: d.id });
          }
        }
        for (const r of Object.values(draft.repairs)) {
          if (r.orderId === id) {
            delete draft.repairs[r.id];
            ops.push({ op: "deleteRepair", id: r.id });
          }
        }
      },
      ops,
      `删除工单 ${id}`,
    );
  }

  // ---- 对端合并 ----

  mergeRemote(remote: Ledger, label = "合并对端改动"): { conflicts: FieldConflict[]; changedCount: number } {
    const before = this.state;
    const { merged, conflicts, changedCount } = mergeLedgers(before, remote);
    invalidateMaterialChanges(before, merged);
    recomputeValidity(merged);
    const ops = diffToOps(before, merged);
    merged.deviceId = before.deviceId;
    merged.outbox = before.outbox;
    this.state = merged;
    this.emit();
    void this.persist(ops, label);
    return { conflicts, changedCount };
  }

  resolveConflict(conflictId: string, side: "local" | "remote"): void {
    const before = this.state;
    const conflict = before.conflicts.find((c) => c.id === conflictId);
    if (!conflict) return;
    const draft = clone(before);
    const value = side === "local" ? conflict.local : conflict.remote;
    const plural = `${conflict.kind}s`;
    const draftMap = draft as unknown as Record<string, Record<string, unknown>>;
    if (conflict.field === "existence") {
      // 整条记录冲突：采用对端 = 删除；采用本地 = 保留
      if (side === "remote") {
        delete draftMap[plural][conflict.entityId];
      }
    } else {
      const ent = draftMap[plural][conflict.entityId] as Record<string, unknown> | undefined;
      if (ent) {
        ent[conflict.field] = value;
        ent.updatedAt = Date.now();
        ent.updatedBy = this.state.deviceId;
      }
    }
    draft.conflicts = draft.conflicts.filter((c) => c.id !== conflictId);
    recomputeValidity(draft);
    const ops = diffToOps(before, draft);
    this.state = draft;
    this.emit();
    void this.persist(ops, `解决冲突 ${conflictId}`);
  }

  /** 重置台账（清本地数据） */
  resetAll(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.state = migrate(null);
    this.emit();
    void this.persist([], "重置台账");
  }

  getSchemaVersion(): number {
    return SCHEMA_VERSION;
  }
}

export const ledgerStore = new LedgerStore();

export function useLedger(): Ledger {
  return useSyncExternalStore(ledgerStore.subscribe, ledgerStore.getState);
}
