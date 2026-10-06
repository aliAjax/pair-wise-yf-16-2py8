import type { DamagePoint, Ledger, RepairRecord, WorkOrder } from "./types";
import { nextId } from "./ids";

const PEER = "tablet-B";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function base(ledger: Ledger): Ledger {
  const remote = clone(ledger);
  remote.deviceId = PEER;
  remote.conflicts = [];
  remote.outbox = [];
  return remote;
}

function touchOrder(remote: Ledger, id: string, patch: Partial<WorkOrder>): void {
  const o = remote.orders[id];
  if (!o) return;
  Object.assign(o, patch, { updatedAt: Date.now(), updatedBy: PEER, version: o.version + 1 });
  for (const f of Object.keys(patch)) {
    remote.fieldMeta[`order:${id}:${f}`] = { at: Date.now(), by: PEER };
  }
}

function touchDamage(remote: Ledger, id: string, patch: Partial<DamagePoint>): void {
  const d = remote.damages[id];
  if (!d) return;
  Object.assign(d, patch, { updatedAt: Date.now(), updatedBy: PEER, version: d.version + 1 });
  for (const f of Object.keys(patch)) {
    remote.fieldMeta[`damage:${id}:${f}`] = { at: Date.now(), by: PEER };
  }
}

function touchRepair(remote: Ledger, id: string, patch: Partial<RepairRecord>): void {
  const r = remote.repairs[id];
  if (!r) return;
  Object.assign(r, patch, { updatedAt: Date.now(), updatedBy: PEER, version: r.version + 1 });
  for (const f of Object.keys(patch)) {
    remote.fieldMeta[`repair:${id}:${f}`] = { at: Date.now(), by: PEER };
  }
}

/** 对端修改工单字段（品牌） */
export function peerEditOrder(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const order = Object.values(remote.orders)[0];
  if (order) touchOrder(remote, order.id, { boardBrand: order.boardBrand.includes("Burton") ? "Burton 160W" : "Burton 156W" });
  return remote;
}

/** 对端新增损伤点 */
export function peerAddDamage(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const order = Object.values(remote.orders)[0];
  if (!order) return remote;
  const { id, seq } = nextId(remote.seq, "damage");
  remote.seq = seq;
  const now = Date.now();
  remote.damages[id] = {
    id,
    orderId: order.id,
    location: "板尾右侧磕碰 5cm",
    kind: "磕碰",
    size: "5cm",
    note: "对端平板新增",
    version: 1,
    createdAt: now,
    updatedAt: now,
    updatedBy: PEER,
  };
  for (const f of ["location", "kind", "size", "note"]) {
    remote.fieldMeta[`damage:${id}:${f}`] = { at: now, by: PEER };
  }
  return remote;
}

/** 对端修改损伤点位置（触发已确认修补作废） */
export function peerEditDamage(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const damage = Object.values(remote.damages)[0];
  if (damage) touchDamage(remote, damage.id, { location: "板头左侧划痕 18cm（对端复测）", size: "18cm" });
  return remote;
}

/** 对端新增修补记录（关联真实损伤点） */
export function peerAddRepair(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const damage = Object.values(remote.damages)[0];
  const orderId = damage?.orderId ?? Object.values(remote.orders)[0]?.id;
  if (!orderId || !damage) return remote;
  const { id, seq } = nextId(remote.seq, "repair");
  remote.seq = seq;
  const now = Date.now();
  remote.repairs[id] = {
    id,
    orderId,
    damageId: damage.id,
    damageLocation: damage.location,
    material: "金属腻子",
    method: "冷补",
    result: "待确认",
    confirmed: false,
    invalid: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    updatedBy: PEER,
  };
  for (const f of ["damageId", "material", "method", "result", "confirmed"]) {
    remote.fieldMeta[`repair:${id}:${f}`] = { at: now, by: PEER };
  }
  return remote;
}

/** 对端修改修补材料（触发作废） */
export function peerEditRepairMaterial(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const repair = Object.values(remote.repairs)[0];
  if (repair) touchRepair(remote, repair.id, { material: repair.material === "P-Tex" ? "金属腻子" : "P-Tex" });
  return remote;
}

/** 对端确认修补 */
export function peerConfirmRepair(ledger: Ledger): Ledger {
  const remote = base(ledger);
  const repair = Object.values(remote.repairs).find((r) => !r.confirmed) ?? Object.values(remote.repairs)[0];
  if (repair) {
    touchRepair(remote, repair.id, { confirmed: true, confirmedAt: Date.now(), invalid: false, invalidReason: undefined });
  }
  return remote;
}

/** 从 JSON 文本解析对端台账 */
export function parsePeerJson(text: string): Ledger {
  const parsed = JSON.parse(text) as Ledger;
  if (typeof parsed !== "object" || parsed === null || !parsed.orders) {
    throw new Error("不是有效的台账 JSON");
  }
  parsed.deviceId = PEER;
  return parsed;
}
