import {
  ConflictRef,
  DamageFieldKey,
  FIELD_DEFS,
  FieldKey,
  LedgerDoc,
  OrderRecord,
  RepairFieldKey,
  Tracked,
} from "./types";

export function fieldLabel(key: FieldKey): string {
  return FIELD_DEFS.find((d) => d.key === key)?.label ?? key;
}

const DAMAGE_LABELS: Record<DamageFieldKey, string> = {
  kind: "损伤类型",
  position: "底板位置",
  sizeCm: "尺寸(cm)",
  note: "备注",
  status: "修补状态",
};
const REPAIR_LABELS: Record<RepairFieldKey, string> = {
  material: "修补材料",
  method: "修补方式",
  technician: "技师",
  confirmed: "确认状态",
  confirmNote: "确认备注",
};
export const damageLabel = (k: DamageFieldKey) => DAMAGE_LABELS[k];
export const repairLabel = (k: RepairFieldKey) => REPAIR_LABELS[k];

/** 收集整篇台账中所有待确认冲突 */
export function collectConflicts(doc: LedgerDoc): { ref: ConflictRef; tracked: Tracked }[] {
  const out: { ref: ConflictRef; tracked: Tracked }[] = [];
  for (const order of Object.values(doc.orders)) {
    for (const key of Object.keys(order.fields) as FieldKey[]) {
      const t = order.fields[key];
      if (t.conflict) out.push({ ref: { scope: "field", orderId: order.id, field: key }, tracked: t });
    }
    for (const d of order.damages) {
      for (const k of ["kind", "position", "sizeCm", "note", "status"] as DamageFieldKey[]) {
        if (d[k].conflict) {
          out.push({ ref: { scope: "damage", orderId: order.id, damageId: d.id, field: k }, tracked: d[k] });
        }
      }
    }
    for (const r of order.repairs) {
      for (const k of ["material", "method", "technician", "confirmed", "confirmNote"] as RepairFieldKey[]) {
        if (r[k].conflict) {
          out.push({ ref: { scope: "repair", orderId: order.id, repairId: r.id, field: k }, tracked: r[k] });
        }
      }
    }
  }
  return out;
}

export function describeConflict(doc: LedgerDoc, ref: ConflictRef): string {
  const order = doc.orders[ref.orderId];
  if (!order) return "冲突";
  const label = order.fields.orderNo.value || order.id;
  if (ref.scope === "field") return `${label} · ${fieldLabel(ref.field)}`;
  if (ref.scope === "damage") {
    const d = order.damages.find((x) => x.id === ref.damageId);
    return `${label} · 损伤点 ${ref.damageId}（${d?.position.value || "位置未填"}）· ${damageLabel(ref.field)}`;
  }
  return `${label} · 修补记录 ${ref.repairId} · ${repairLabel(ref.field)}`;
}

/** 在一份工单中按引用拿到 Tracked（仲裁后就地更新由调用方重新渲染） */
export function getTracked(
  order: OrderRecord,
  ref: ConflictRef,
): Tracked | null {
  if (ref.scope === "field") return order.fields[ref.field];
  if (ref.scope === "damage")
    return order.damages.find((d) => d.id === ref.damageId)?.[ref.field] ?? null;
  return order.repairs.find((r) => r.id === ref.repairId)?.[ref.field] ?? null;
}

export function formatTime(at: number): string {
  if (!at) return "—";
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 工单状态筛选用统计 */
export function orderStats(orders: OrderRecord[]) {
  return {
    total: orders.length,
    open: orders.filter((o) => o.fields.status.value !== "已完工").length,
    done: orders.filter((o) => o.fields.status.value === "已完工").length,
    damages: orders.reduce((n, o) => n + o.damages.length, 0),
  };
}
