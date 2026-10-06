import {
  AddDamageOp,
  AddRepairOp,
  ApplyResult,
  Changeset,
  Candidate,
  CommitEntry,
  Conflict,
  Damage,
  DamageFieldKey,
  FIELD_DEFS,
  FieldKey,
  LedgerDoc,
  OrderRecord,
  Repair,
  RepairFieldKey,
  SCHEMA_VERSION,
  Tracked,
  ConflictRef,
  InvalidatedRef,
} from "./types";

/* ---------------- 构造 ---------------- */

export function emptyTracked(value: string, rev: number, by: string, at: number): Tracked {
  return { value, rev, by, at };
}

export function blankOrderFields(rev: number, by: string, at: number) {
  const fields = {} as Record<FieldKey, Tracked>;
  for (const def of FIELD_DEFS) {
    fields[def.key] = emptyTracked("", rev, by, at);
  }
  return fields;
}

export function createEmptyDoc(): LedgerDoc {
  return {
    version: SCHEMA_VERSION,
    rev: 0,
    seqOrder: 0,
    orders: {},
    applied: {},
    log: [],
    devices: [],
  };
}

/* ---------------- 打蜡资格与确认作废 ---------------- */

export interface WaxEligibility {
  eligible: boolean;
  reasons: string[];
}

/** 打蜡资格：所有损伤必须已修补，且修补全部已确认 */
export function waxEligibility(order: OrderRecord): WaxEligibility {
  const reasons: string[] = [];
  const open = order.damages.filter((d) => d.status.value.trim() !== "已修补");
  for (const d of open) {
    reasons.push(`损伤点 ${d.id}（${d.position.value || "位置未填"}）尚未标记已修补`);
  }
  const unconfirmed = order.repairs.filter((r) => r.confirmed.value !== "是");
  for (const r of unconfirmed) {
    const target = r.damageId ? `损伤点 ${r.damageId}` : "未关联损伤点的修补";
    reasons.push(`修补记录 ${r.id}（${target}）未确认`);
  }
  // 关联的损伤点已不存在（旧升级遗留或删除场景）也不允许
  const dangling = order.repairs.filter(
    (r) => r.damageId && !order.damages.some((d) => d.id === r.damageId),
  );
  for (const r of dangling) {
    reasons.push(`修补记录 ${r.id} 关联的损伤点 ${r.damageId} 不存在`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/** 作废一张修补确认：保留原结论痕迹，状态回到“否”并写明原因 */
export function invalidateRepair(repair: Repair, reason: string, at: number): void {
  if (repair.confirmed.value === "是") {
    repair.confirmed = {
      ...repair.confirmed,
      value: "否",
    };
  }
  repair.confirmNote = {
    ...repair.confirmNote,
    value: `【已作废，待重新确认】${reason}`,
    at,
  };
}

/* ---------------- 字段级三路合并 ---------------- */

/**
 * 三路合并一个字段。
 * @param current 台账现值（null 表示实体/字段首次出现）
 * @param base    本机编辑所依据的值（null 表示从无到有）
 * @param edit    本机新值
 * @returns        合并后的字段状态；返回 null 表示本机未实际改动（edit===base），跳过
 */
export function mergeTracked(
  current: Tracked | null,
  base: string | null,
  edit: string,
  meta: { rev: number; by: string; at: number },
): { tracked: Tracked; conflicted: boolean } | null {
  if (base !== null && edit === base) return null; // 没改
  if (edit === (current ? current.value : null)) return null; // 现值已经一致（对端写过同样内容）

  const mine: Candidate = { value: edit, by: meta.by, at: meta.at };

  // 首次创建
  if (!current) {
    return { tracked: emptyTracked(edit, meta.rev, meta.by, meta.at), conflicted: false };
  }

  const currentBase = base === null ? null : base;
  const unchanged = currentBase === null ? current.value === "" : current.value === currentBase;
  // 对端未动该字段（或现值仍是空基线）→ 直接快进
  if (unchanged) {
    return {
      tracked: { ...current, value: edit, rev: meta.rev, by: meta.by, at: meta.at },
      conflicted: false,
    };
  }

  // 双方都改了同一字段，且值不同 → 保留现值为当前值，双方版本各留一版待确认
  const existing = current.conflict;
  const candidates: Candidate[] = [];
  const push = (c: Candidate) => {
    if (!candidates.some((x) => x.value === c.value)) candidates.push(c);
  };
  push({ value: current.value, by: current.by, at: current.at });
  if (existing) {
    for (const c of existing.candidates) push(c);
  }
  push(mine);

  const conflict: Conflict = { candidates };
  // 若此前已有仲裁结论，且仲裁值仍等于现值，保留该结论展示；否则清掉等待重新仲裁
  if (existing?.resolvedValue !== undefined && existing.resolvedValue === current.value) {
    conflict.resolvedValue = existing.resolvedValue;
    conflict.resolvedBy = existing.resolvedBy;
    conflict.resolvedAt = existing.resolvedAt;
  }

  return {
    tracked: { ...current, conflict },
    conflicted: true,
  };
}

/* ---------------- 实体工厂（批次落盘时分配稳定编号） ---------------- */

function buildDamage(
  doc: LedgerDoc,
  order: OrderRecord,
  op: AddDamageOp,
  cs: Changeset,
): Damage {
  order.seqDamage += 1;
  const id = `D-${String(order.seqDamage).padStart(3, "0")}`;
  const mk = (v: string): Tracked => emptyTracked(v, doc.rev, cs.deviceName, cs.at);
  return {
    id,
    kind: mk(op.data.kind ?? ""),
    position: mk(op.data.position ?? ""),
    sizeCm: mk(op.data.sizeCm ?? ""),
    note: mk(op.data.note ?? ""),
    status: mk(op.data.status ?? "待修补"),
    rev: doc.rev,
    addedBy: cs.deviceName,
    addedAt: cs.at,
  };
}

function buildRepair(
  doc: LedgerDoc,
  order: OrderRecord,
  op: AddRepairOp,
  damageId: string,
  cs: Changeset,
): Repair {
  order.seqRepair += 1;
  const id = `R-${String(order.seqRepair).padStart(3, "0")}`;
  const mk = (v: string): Tracked => emptyTracked(v, doc.rev, cs.deviceName, cs.at);
  return {
    id,
    damageId,
    material: mk(op.data.material ?? ""),
    method: mk(op.data.method ?? ""),
    technician: mk(op.data.technician ?? ""),
    confirmed: mk(op.data.confirmed ?? "否"),
    confirmNote: mk(op.data.confirmNote ?? ""),
    rev: doc.rev,
    addedBy: cs.deviceName,
    addedAt: cs.at,
  };
}

/* ---------------- 批次应用 ---------------- */

const DAMAGE_TRIGGER_FIELDS: DamageFieldKey[] = ["kind", "position", "sizeCm", "status"];
const INVALID_NOTE: Record<RepairFieldKey, string> = {
  material: "修补材料被修改",
  method: "修补方式被修改",
  technician: "施工技师被修改",
  confirmed: "确认状态被修改",
  confirmNote: "确认备注被修改",
};

export function applyChangeset(doc: LedgerDoc, cs: Changeset): ApplyResult {
  const result: ApplyResult = {
    applied: false,
    orderIds: {},
    damageIds: {},
    repairIds: {},
    conflicts: [],
    invalidatedRepairs: [],
  };
  if (!cs || !cs.id || doc.applied[cs.id]) return result; // 幂等

  doc.rev += 1;
  const meta = { rev: doc.rev, by: cs.deviceName, at: cs.at };

  // 第一遍：新增工单（分配稳定编号）
  for (const op of cs.ops) {
    if (op.kind !== "addOrder") continue;
    doc.seqOrder += 1;
    const id = `ORD-${String(doc.seqOrder).padStart(3, "0")}`;
    result.orderIds[op.localId] = id;
    const fields = blankOrderFields(doc.rev, cs.deviceName, cs.at);
    for (const [k, v] of Object.entries(op.fields)) {
      const key = k as FieldKey;
      if (v !== undefined && fields[key]) fields[key] = emptyTracked(v, doc.rev, cs.deviceName, cs.at);
    }
    doc.orders[id] = {
      id,
      fields,
      damages: [],
      repairs: [],
      seqDamage: 0,
      seqRepair: 0,
      createdAt: cs.at,
      updatedAt: cs.at,
    };
  }

  // 第二遍：新增损伤点（引用解析后可知道所属工单）
  for (const op of cs.ops) {
    if (op.kind !== "addDamage") continue;
    const orderId = result.orderIds[op.orderId] ?? op.orderId;
    const order = doc.orders[orderId];
    if (!order) continue;
    const damage = buildDamage(doc, order, op, cs);
    order.damages.push(damage);
    result.damageIds[op.localId] = damage.id;
  }

  // 第三遍：新增修补记录（解析真实损伤点编号，允许指向同批次新增损伤点）
  for (const op of cs.ops) {
    if (op.kind !== "addRepair") continue;
    const orderId = result.orderIds[op.orderId] ?? op.orderId;
    const order = doc.orders[orderId];
    if (!order) continue;
    let damageId = "";
    if (op.damageLocalId) {
      damageId = result.damageIds[op.damageLocalId] ?? op.damageLocalId;
      if (!order.damages.some((d) => d.id === damageId)) damageId = ""; // 挂空保护
    }
    const repair = buildRepair(doc, order, op, damageId, cs);
    order.repairs.push(repair);
    result.repairIds[op.localId] = repair.id;
  }

  const dirtyDamage = new Map<string, Map<string, Set<DamageFieldKey>>>();
  const dirtyRepair = new Map<string, Map<string, Set<RepairFieldKey>>>();
  const touchDamage = (orderId: string, damageId: string, field: DamageFieldKey) => {
    const m = dirtyDamage.get(orderId) ?? new Map<string, Set<DamageFieldKey>>();
    const s = m.get(damageId) ?? new Set<DamageFieldKey>();
    s.add(field);
    m.set(damageId, s);
    dirtyDamage.set(orderId, m);
  };
  const touchRepair = (orderId: string, repairId: string, field: RepairFieldKey) => {
    const m = dirtyRepair.get(orderId) ?? new Map<string, Set<RepairFieldKey>>();
    const s = m.get(repairId) ?? new Set<RepairFieldKey>();
    s.add(field);
    m.set(repairId, s);
    dirtyRepair.set(orderId, m);
  };

  const setOrderField = (
    order: OrderRecord,
    field: FieldKey,
    value: string,
    base: string | null,
  ) => {
    const merged = mergeTracked(order.fields[field] ?? null, base, value, meta);
    if (merged) {
      order.fields[field] = merged.tracked;
      if (merged.conflicted) result.conflicts.push({ scope: "field", orderId: order.id, field });
    }
  };

  // 第四遍：字段修改与冲突仲裁
  for (const op of cs.ops) {
    if (op.kind === "setField") {
      const orderId = result.orderIds[op.orderId] ?? op.orderId;
      const order = doc.orders[orderId];
      if (order) setOrderField(order, op.field, op.value, op.base);
    } else if (op.kind === "setDamageField") {
      const order = doc.orders[op.orderId];
      const damage = order?.damages.find((d) => d.id === op.damageId);
      if (order && damage) {
        const merged = mergeTracked(damage[op.field], op.base, op.value, meta);
        if (merged) {
          damage[op.field] = merged.tracked;
          damage.rev = doc.rev;
          touchDamage(order.id, damage.id, op.field);
          if (merged.conflicted)
            result.conflicts.push({
              scope: "damage",
              orderId: order.id,
              damageId: damage.id,
              field: op.field,
            });
        }
      }
    } else if (op.kind === "setRepairField") {
      const order = doc.orders[op.orderId];
      const repair = order?.repairs.find((r) => r.id === op.repairId);
      if (order && repair) {
        const merged = mergeTracked(repair[op.field], op.base, op.value, meta);
        if (merged) {
          repair[op.field] = merged.tracked;
          repair.rev = doc.rev;
          touchRepair(order.id, repair.id, op.field);
          if (merged.conflicted)
            result.conflicts.push({
              scope: "repair",
              orderId: order.id,
              repairId: repair.id,
              field: op.field,
            });
        }
      }
    } else if (op.kind === "resolveField" || op.kind === "resolveDamageField" || op.kind === "resolveRepairField") {
      const order = doc.orders[op.orderId];
      if (!order) continue;
      let tracked: Tracked | undefined;
      if (op.kind === "resolveField") tracked = order.fields[op.field];
      else if (op.kind === "resolveDamageField")
        tracked = order.damages.find((d) => d.id === op.damageId)?.[op.field];
      else tracked = order.repairs.find((r) => r.id === op.repairId)?.[op.field];
      if (tracked?.conflict) {
        const chosen = op.value;
        tracked.value = chosen;
        tracked.rev = doc.rev;
        tracked.by = cs.deviceName;
        tracked.at = cs.at;
        tracked.conflict = {
          candidates: tracked.conflict.candidates,
          resolvedValue: chosen,
          resolvedBy: cs.deviceName,
          resolvedAt: cs.at,
        };
      }
    }
  }

  // 第五遍：联动作废重算
  for (const [orderId, map] of dirtyDamage) {
    const order = doc.orders[orderId];
    if (!order) continue;
    for (const [damageId, fields] of map) {
      const hit = DAMAGE_TRIGGER_FIELDS.some((f) => fields.has(f));
      if (!hit) continue;
      for (const repair of order.repairs) {
        if (repair.damageId === damageId && repair.confirmed.value === "是") {
          const reason = `关联损伤点 ${damageId} 信息已修改（${[...fields].join("、")}）`;
          invalidateRepair(repair, reason, cs.at);
          result.invalidatedRepairs.push({ orderId, repairId: repair.id, reason });
        }
      }
    }
  }
  for (const [orderId, map] of dirtyRepair) {
    const order = doc.orders[orderId];
    if (!order) continue;
    for (const [repairId, fields] of map) {
      if (!fields.has("material")) continue;
      const repair = order.repairs.find((r) => r.id === repairId);
      if (repair && repair.confirmed.value === "是") {
        const reason = INVALID_NOTE.material;
        invalidateRepair(repair, reason, cs.at);
        result.invalidatedRepairs.push({ orderId, repairId, reason });
      }
    }
  }

  // 时间戳与日志
  const summaries: string[] = [];
  const counts: Record<string, number> = {};
  for (const op of cs.ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(counts)) summaries.push(`${k}×${n}`);

  let orderLabel = "";
  const firstOrderRef = cs.ops.find((o) => "orderId" in o) as { orderId?: string } | undefined;
  if (firstOrderRef?.orderId) {
    const id = result.orderIds[firstOrderRef.orderId] ?? firstOrderRef.orderId;
    orderLabel = doc.orders[id]?.fields.orderNo.value || id;
  }

  for (const id of Object.keys(doc.orders)) {
    if (
      cs.ops.some((o) => "orderId" in o && (result.orderIds[o.orderId] ?? o.orderId) === id)
    ) {
      doc.orders[id].updatedAt = cs.at;
    }
  }

  const entry: CommitEntry = {
    id: `${cs.id}:log`,
    changesetId: cs.id,
    at: cs.at,
    by: cs.deviceName,
    orderId: firstOrderRef ? result.orderIds[firstOrderRef.orderId!] ?? firstOrderRef.orderId! : "",
    orderLabel,
    summary: summaries.join("，"),
  };
  doc.log.unshift(entry);
  if (doc.log.length > 200) doc.log.length = 200;

  // 设备名册
  const device = doc.devices.find((d) => d.id === cs.deviceId);
  if (device) {
    device.name = cs.deviceName;
    device.lastSeen = cs.at;
  } else {
    doc.devices.push({ id: cs.deviceId, name: cs.deviceName, createdAt: cs.at, lastSeen: cs.at });
  }

  doc.applied[cs.id] = true;
  result.applied = true;
  return result;
}

/** 把多个批次按时间顺序应用到一份文档（用于加载时重放未提交批次） */
export function applyAll(doc: LedgerDoc, list: Changeset[]): ApplyResult[] {
  const sorted = [...list].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return sorted.map((cs) => applyChangeset(doc, cs));
}
