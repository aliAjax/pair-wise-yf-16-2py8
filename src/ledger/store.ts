import { useCallback, useEffect, useMemo, useState } from "react";
import {
  commitChangeset,
  flushQueue,
  getDevice,
  loadDoc,
  loadLegacySample,
  notifyLocal,
  readQueue,
  resetAll,
  setDeviceName,
  setSimulateFail,
  subscribeLedger,
  subscribeQueue,
} from "./storage";
import { waxEligibility } from "./merge";
import {
  Changeset,
  ChangesetOp,
  DamageFieldKey,
  FieldKey,
  LedgerDoc,
  OrderRecord,
  RepairFieldKey,
  TEMP_PREFIX,
  newTempId,
  ApplyResult,
} from "./types";

/* ---------------- 快照（保存时的三路合并基线） ---------------- */

export interface Snapshot {
  rev: number;
  fields: Record<FieldKey, string>;
  damages: Record<
    string,
    { fields: Record<DamageFieldKey, string> }
  >;
  repairs: Record<
    string,
    { fields: Record<RepairFieldKey, string>; damageId: string }
  >;
}

export function snapshotOrder(order: OrderRecord): Snapshot {
  const fields = {} as Record<FieldKey, string>;
  for (const k of Object.keys(order.fields) as FieldKey[]) fields[k] = order.fields[k].value;
  const damages: Snapshot["damages"] = {};
  for (const d of order.damages) {
    damages[d.id] = {
      fields: {
        kind: d.kind.value,
        position: d.position.value,
        sizeCm: d.sizeCm.value,
        note: d.note.value,
        status: d.status.value,
      },
    };
  }
  const repairs: Snapshot["repairs"] = {};
  for (const r of order.repairs) {
    repairs[r.id] = {
      damageId: r.damageId,
      fields: {
        material: r.material.value,
        method: r.method.value,
        technician: r.technician.value,
        confirmed: r.confirmed.value,
        confirmNote: r.confirmNote.value,
      },
    };
  }
  return { rev: -1, fields, damages, repairs };
}

export function blankSnapshot(): Snapshot {
  return snapshotOrder({
    id: "",
    fields: {} as OrderRecord["fields"],
    damages: [],
    repairs: [],
    seqDamage: 0,
    seqRepair: 0,
    createdAt: 0,
    updatedAt: 0,
  } as OrderRecord);
}

/* ---------------- 编辑草稿 ---------------- */

export interface NewDamage {
  localId: string;
  data: Record<DamageFieldKey, string>;
}
export interface NewRepair {
  localId: string;
  damageLocalId: string | null; // 稳定编号或同批次损伤点临时编号
  data: Partial<Record<RepairFieldKey, string>>;
}

export interface Draft {
  /** 已存在工单的稳定编号；新工单为临时编号 */
  orderId: string;
  isNew: boolean;
  fields: Record<FieldKey, string>;
  /** 已存在损伤点的字段覆盖（只存改后值） */
  damageEdits: Record<string, Partial<Record<DamageFieldKey, string>>>;
  repairEdits: Record<string, Partial<Record<RepairFieldKey, string>>>;
  newDamages: NewDamage[];
  newRepairs: NewRepair[];
  snapshot: Snapshot;
}

export function startDraft(existing: OrderRecord | null): Draft {
  if (existing) {
    return {
      orderId: existing.id,
      isNew: false,
      fields: { ...snapshotOrder(existing).fields },
      damageEdits: {},
      repairEdits: {},
      newDamages: [],
      newRepairs: [],
      snapshot: snapshotOrder(existing),
    };
  }
  const orderId = newTempId();
  const fields = {} as Record<FieldKey, string>;
  for (const k of Object.keys(blankSnapshot().fields) as FieldKey[]) fields[k] = "";
  return {
    orderId,
    isNew: true,
    fields,
    damageEdits: {},
    repairEdits: {},
    newDamages: [],
    newRepairs: [],
    snapshot: blankSnapshot(),
  };
}

export function draftIsDirty(draft: Draft): boolean {
  if (draft.isNew) {
    const anyField = Object.values(draft.fields).some((v) => v.trim() !== "");
    return anyField || draft.newDamages.length > 0 || draft.newRepairs.length > 0;
  }
  const s = draft.snapshot;
  for (const k of Object.keys(draft.fields) as FieldKey[]) {
    if (draft.fields[k] !== s.fields[k]) return true;
  }
  if (Object.keys(draft.damageEdits).length > 0) return true;
  if (Object.keys(draft.repairEdits).length > 0) return true;
  if (draft.newDamages.length > 0 || draft.newRepairs.length > 0) return true;
  return false;
}

function buildOps(draft: Draft): ChangesetOp[] {
  const ops: ChangesetOp[] = [];
  if (draft.isNew) {
    const fields: Partial<Record<FieldKey, string>> = {};
    for (const [k, v] of Object.entries(draft.fields)) {
      if (v.trim() !== "") fields[k as FieldKey] = v;
    }
    ops.push({ kind: "addOrder", localId: draft.orderId, fields });
  } else {
    for (const k of Object.keys(draft.fields) as FieldKey[]) {
      if (draft.fields[k] !== draft.snapshot.fields[k]) {
        ops.push({
          kind: "setField",
          orderId: draft.orderId,
          field: k,
          value: draft.fields[k],
          base: draft.snapshot.fields[k],
        });
      }
    }
  }

  for (const nd of draft.newDamages) {
    const op: ChangesetOp = {
      kind: "addDamage",
      orderId: draft.orderId,
      localId: nd.localId,
      data: nd.data,
    };
    ops.push(op);
  }

  for (const nr of draft.newRepairs) {
    ops.push({
      kind: "addRepair",
      orderId: draft.orderId,
      localId: nr.localId,
      damageLocalId: nr.damageLocalId,
      data: nr.data,
    });
  }

  for (const [damageId, edits] of Object.entries(draft.damageEdits)) {
    const baseFields = draft.snapshot.damages[damageId]?.fields;
    if (!baseFields) continue;
    for (const [f, v] of Object.entries(edits)) {
      const field = f as DamageFieldKey;
      if (v !== undefined && v !== baseFields[field]) {
        ops.push({
          kind: "setDamageField",
          orderId: draft.orderId,
          damageId,
          field,
          value: v,
          base: baseFields[field],
        });
      }
    }
  }

  for (const [repairId, edits] of Object.entries(draft.repairEdits)) {
    const base = draft.snapshot.repairs[repairId];
    if (!base) continue;
    for (const [f, v] of Object.entries(edits)) {
      const field = f as RepairFieldKey;
      if (v !== undefined && v !== base.fields[field]) {
        ops.push({
          kind: "setRepairField",
          orderId: draft.orderId,
          repairId,
          field,
          value: v,
          base: base.fields[field],
        });
      }
    }
  }

  return ops;
}

/* ---------------- 全局提示与 Store ---------------- */

export interface Toast {
  id: number;
  level: "info" | "warn" | "error" | "success";
  text: string;
}

export interface Store {
  doc: LedgerDoc;
  device: ReturnType<typeof getDevice>;
  queue: Changeset[];
  toasts: Toast[];
  upgraded: boolean;
}

let toastSeq = 0;

export function useLedgerStore() {
  const initial = useMemo(loadDoc, []);
  const [doc, setDoc] = useState<LedgerDoc>(initial.doc);
  const [device, setDevice] = useState(getDevice);
  const [queue, setQueue] = useState<Changeset[]>(() => readQueue());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [upgraded, setUpgraded] = useState(initial.upgraded);

  const pushToast = useCallback((level: Toast["level"], text: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-4), { id, level, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // 初次挂载后的队列状态由 subscribeQueue 维护，保存后主动刷新
  useEffect(() => {
    setQueue(readQueue());
  }, []);

  useEffect(() => {
    const offDoc = subscribeLedger((next) => {
      setDoc(next);
    });
    const offQueue = subscribeQueue((q) => setQueue(q));
    return () => {
      offDoc();
      offQueue();
    };
  }, []);

  useEffect(() => {
    if (upgraded) {
      pushToast("success", "旧台账已升级：损伤点/修补记录已补发稳定编号，原位置记录保留可查，修补需重新确认。");
    }
  }, [upgraded, pushToast]);

  const saveDraft = useCallback(
    (draft: Draft): { ok: boolean; result: ApplyResult | null; orderId: string; draft: Draft } => {
      const ops = buildOps(draft);
      if (ops.length === 0) {
        return { ok: true, result: null, orderId: draft.orderId, draft };
      }
      const cs: Changeset = {
        id: `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        deviceId: device.id,
        deviceName: device.name,
        at: Date.now(),
        ops,
      };
      const outcome = commitChangeset(cs);
      if (outcome.error) {
        pushToast("error", outcome.error);
        setQueue(readQueue());
        return { ok: false, result: null, orderId: draft.orderId, draft };
      }
      setDoc(outcome.doc);
      notifyLocal(outcome.doc);
      const r = outcome.result;

      // 临时编号 → 稳定编号映射，返回给 UI 重新打开草稿
      let stableOrderId = draft.orderId;
      let nextDraft = draft;
      if (draft.isNew) {
        stableOrderId = r?.orderIds[draft.orderId] ?? draft.orderId;
        const order = outcome.doc.orders[stableOrderId];
        nextDraft = order ? startDraft(order) : draft;
      } else {
        const order = outcome.doc.orders[draft.orderId];
        if (order) nextDraft = startDraft(order);
      }

      if (r && r.conflicts.length > 0) {
        pushToast(
          "warn",
          `已按字段合并保存，${r.conflicts.length} 处两台平板都改过，双方版本已保留，等待人工确认。`,
        );
      }
      if (r && r.invalidatedRepairs.length > 0) {
        pushToast(
          "warn",
          `损伤点/材料改动导致 ${r.invalidatedRepairs.length} 条已确认修补立即作废，打蜡资格已重算。`,
        );
      }
      if (r && r.conflicts.length === 0 && r.invalidatedRepairs.length === 0) {
        pushToast("success", "批次已写盘，字段合并完成。");
      }
      setQueue([]);
      return { ok: true, result: r, orderId: stableOrderId, draft: nextDraft };
    },
    [device, pushToast],
  );

  const resolveConflict = useCallback(
    (ops: ChangesetOp[]) => {
      if (ops.length === 0) return;
      const cs: Changeset = {
        id: `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        deviceId: device.id,
        deviceName: device.name,
        at: Date.now(),
        ops,
      };
      const outcome = commitChangeset(cs);
      if (outcome.error) pushToast("error", outcome.error);
      else {
        setDoc(outcome.doc);
        notifyLocal(outcome.doc);
        pushToast("success", "冲突已仲裁，采用选定版本。");
      }
    },
    [device, pushToast],
  );

  const retryQueue = useCallback(() => {
    const r = flushQueue();
    if ("error" in r) {
      pushToast("error", `重试仍失败，未提交批次继续保留：${r.error}`);
    } else {
      setDoc(r.doc);
      notifyLocal(r.doc);
      pushToast("success", `未提交批次已补写成功（${r.flushed} 个批次）。`);
    }
  }, [pushToast]);

  const renameDevice = useCallback(
    (name: string) => {
      const next = setDeviceName(name);
      setDevice(next);
      // 改名也提交一个空批次没必要；仅本机生效，后续批次携带新名
    },
    [],
  );

  const toggleFail = useCallback(
    (on: boolean) => {
      setSimulateFail(on);
      pushToast(on ? "warn" : "info", on ? "已开启“模拟写盘失败”，下次保存将进入未提交重试流程。" : "已关闭写盘失败模拟。");
    },
    [pushToast],
  );

  const reset = useCallback(() => {
    resetAll();
    const loaded = loadDoc();
    setDoc(loaded.doc);
    setUpgraded(loaded.upgraded);
    notifyLocal(loaded.doc);
  }, []);

  const loadLegacy = useCallback(() => {
    loadLegacySample();
    const loaded = loadDoc(); // 自动升级、补齐编号、尝试落盘
    setDoc(loaded.doc);
    setUpgraded(true);
    notifyLocal(loaded.doc);
    pushToast("success", "已载入 v1 旧台账并自动升级：编号已补齐，原损伤/修复位置保留可查，修补需重新确认。");
  }, [pushToast]);

  return {
    doc,
    device,
    queue,
    toasts,
    upgraded,
    saveDraft,
    resolveConflict,
    retryQueue,
    renameDevice,
    toggleFail,
    reset,
    loadLegacy,
    waxFor: (order: OrderRecord) => waxEligibility(order),
  };
}

export { TEMP_PREFIX };
