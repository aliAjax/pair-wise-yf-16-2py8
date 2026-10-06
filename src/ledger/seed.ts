import { createEmptyDoc, emptyTracked } from "./merge";
import {
  Damage,
  DamageFieldKey,
  FIELD_DEFS,
  FieldKey,
  LedgerDoc,
  OrderRecord,
  Repair,
  RepairFieldKey,
  Tracked,
} from "./types";

/** 首次打开时的示例台账（本身即标准 v2 结构，含稳定编号） */
export function seedDoc(): LedgerDoc {
  const doc = createEmptyDoc();
  doc.rev = 1;
  const now = Date.now();
  const by = "示例数据";

  const order = (
    orderNo: string,
    values: Partial<Record<FieldKey, string>>,
    damages: Array<[DamageFieldKey, string][][]> = [],
    repairs: Array<{ damageIdx: number | null; values: Partial<Record<RepairFieldKey, string>>; legacy?: string }> = [],
  ): OrderRecord => {
    doc.seqOrder += 1;
    const id = `ORD-${String(doc.seqOrder).padStart(3, "0")}`;
    const fields = {} as Record<FieldKey, Tracked>;
    for (const def of FIELD_DEFS) {
      fields[def.key] = emptyTracked(values[def.key] ?? "", 1, by, now);
    }
    const o: OrderRecord = {
      id,
      fields,
      damages: [],
      repairs: [],
      seqDamage: 0,
      seqRepair: 0,
      createdAt: now,
      updatedAt: now,
    };
    for (const groups of damages) {
      o.seqDamage += 1;
      const t = (v: string) => emptyTracked(v, 1, by, now);
      const data: Record<DamageFieldKey, string> = {
        kind: "划痕",
        position: "",
        sizeCm: "",
        note: "",
        status: "待修补",
      };
      for (const g of groups) for (const [k, v] of g) data[k] = v;
      const dmg: Damage = {
        id: `D-${String(o.seqDamage).padStart(3, "0")}`,
        kind: t(data.kind),
        position: t(data.position),
        sizeCm: t(data.sizeCm),
        note: t(data.note),
        status: t(data.status),
        rev: 1,
        addedBy: by,
        addedAt: now,
      };
      o.damages.push(dmg);
    }
    for (const r of repairs) {
      o.seqRepair += 1;
      const t = (v: string) => emptyTracked(v, 1, by, now);
      o.repairs.push({
        id: `R-${String(o.seqRepair).padStart(3, "0")}`,
        damageId: r.damageIdx !== null ? o.damages[r.damageIdx]?.id ?? "" : "",
        material: t(r.values.material ?? ""),
        method: t(r.values.method ?? ""),
        technician: t(r.values.technician ?? ""),
        confirmed: t(r.values.confirmed ?? "否"),
        confirmNote: t(r.values.confirmNote ?? ""),
        legacyPosition: r.legacy,
        rev: 1,
        addedBy: by,
        addedAt: now,
      });
    }
    return o;
  };

  const o1 = order(
    "ORD-112",
    {
      orderNo: "ORD-112",
      brand: "竞速板 165",
      lengthCm: "165",
      boardType: "竞速板",
      edgeSideDeg: "88",
      edgeBaseDeg: "1",
      waxType: "全温蜡",
      status: "维护中",
      customer: "王客户",
      preference: "高速稳定性优先",
    },
    [
      [
        [
          ["kind", "划痕"],
          ["position", "距板头 70cm 左侧刃边"],
          ["sizeCm", "12"],
          ["status", "待修补"],
        ],
      ],
      [
        [
          ["kind", "烧板"],
          ["position", "板尾中央"],
          ["sizeCm", "3"],
          ["status", "已修补"],
        ],
      ],
    ],
    [
      {
        damageIdx: 1,
        values: { material: "P-Tex 黑色", method: "热熔填补", technician: "李技师", confirmed: "是" },
      },
    ],
  );

  const o2 = order(
    "ORD-106",
    {
      orderNo: "ORD-106",
      brand: "Burton 156",
      lengthCm: "156",
      boardType: "全地域",
      edgeSideDeg: "88",
      edgeBaseDeg: "1",
      waxType: "低温蜡",
      status: "待交付",
      customer: "张客户",
      preference: "弱咬雪",
    },
    [
      [
        [
          ["kind", "划痕"],
          ["position", "固定器之间底板"],
          ["sizeCm", "5"],
          ["status", "已修补"],
        ],
      ],
    ],
    [
      {
        damageIdx: 0,
        values: { material: "P-Tex 透明", method: "滴补刮平", technician: "赵技师", confirmed: "是" },
      },
    ],
  );

  const o3 = order(
    "ORD-118",
    {
      orderNo: "ORD-118",
      brand: "粉雪板 158",
      lengthCm: "158",
      boardType: "粉雪板",
      edgeSideDeg: "89",
      edgeBaseDeg: "0",
      waxType: "",
      status: "待维护",
      customer: "陈客户",
      preference: "浮力优先",
    },
    [
      [
        [
          ["kind", "凹伤"],
          ["position", "距板尾 40cm 右侧"],
          ["sizeCm", "2"],
          ["status", "待修补"],
        ],
      ],
    ],
    [],
  );

  doc.orders[o1.id] = o1;
  doc.orders[o2.id] = o2;
  doc.orders[o3.id] = o3;
  return doc;
}
