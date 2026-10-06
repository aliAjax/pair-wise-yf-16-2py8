import type { Ledger, RepairRecord, WorkOrder } from "./types";

/**
 * 作废重算：
 * - 损伤点核心字段（位置/类型/尺寸）改动后，关联的已确认修补立即作废
 * - 修补材料改动后，该修补的确认立即作废
 * - 打蜡资格按工单重算：每个损伤点都有「已确认且未作废」的修补才合格
 */
export function recomputeValidity(ledger: Ledger): void {
  for (const repair of Object.values(ledger.repairs)) {
    const damage = ledger.damages[repair.damageId];
    // 保留损伤点位置快照，损伤点改号/删除后历史依旧可查
    if (damage) {
      repair.damageLocation = damage.location;
    }
    if (repair.confirmed && !repair.invalid) {
      if (!damage) {
        repair.confirmed = false;
        repair.invalid = true;
        repair.invalidReason = "关联损伤点已删除";
        repair.invalidatedAt = Date.now();
      } else if (repair.confirmedDamageVersion == null) {
        // 首次确认（含对端确认），记录当前损伤版本
        repair.confirmedDamageVersion = damage.version;
      } else if (damage.version > repair.confirmedDamageVersion) {
        repair.confirmed = false;
        repair.invalid = true;
        repair.invalidReason = "损伤点在确认后有改动";
        repair.invalidatedAt = Date.now();
      }
    }
  }
}

/** 打蜡资格：返回是否合格及原因 */
export function waxEligibility(
  ledger: Ledger,
  orderId: string,
): { eligible: boolean; reason: string } {
  const damages = Object.values(ledger.damages).filter((d) => d.orderId === orderId);
  if (damages.length === 0) {
    return { eligible: true, reason: "无底板损伤，可直接打蜡" };
  }
  const missing: string[] = [];
  for (const d of damages) {
    const ok = Object.values(ledger.repairs).some(
      (r) => r.damageId === d.id && r.confirmed && !r.invalid,
    );
    if (!ok) missing.push(d.id);
  }
  if (missing.length === 0) {
    return { eligible: true, reason: "全部损伤点已有确认修补，可打蜡" };
  }
  return {
    eligible: false,
    reason: `损伤点 ${missing.join("、")} 尚无确认修补，打蜡资格作废`,
  };
}

/** 合并路径：修补材料改动 → 已确认修补立即作废 */
export function invalidateMaterialChanges(before: Ledger, after: Ledger): void {
  for (const r of Object.values(after.repairs)) {
    const prev = before.repairs[r.id];
    if (prev && prev.material !== r.material && r.confirmed) {
      r.confirmed = false;
      r.invalid = true;
      r.invalidReason = "修补材料有改动";
      r.invalidatedAt = Date.now();
    }
  }
}

export function orderStatusOf(order: WorkOrder): string {
  return order.status;
}

/** 某工单下的损伤点数量 */
export function damageCount(ledger: Ledger, orderId: string): number {
  return Object.values(ledger.damages).filter((d) => d.orderId === orderId).length;
}

/** 某工单下待处理（未确认/已作废）修补数量 */
export function pendingRepairCount(ledger: Ledger, orderId: string): number {
  return Object.values(ledger.repairs).filter(
    (r) => r.orderId === orderId && (!r.confirmed || r.invalid),
  ).length;
}

export type { RepairRecord };
