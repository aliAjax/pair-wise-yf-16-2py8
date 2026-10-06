import { SCHEMA_VERSION, type Ledger, type WorkOrder } from "./types";
import { nextId } from "./ids";

const DEVICE = "tablet-A";

function emptyLedger(): Ledger {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: DEVICE,
    seq: 0,
    orders: {},
    damages: {},
    repairs: {},
    fieldMeta: {},
    synced: { orders: {}, damages: {}, repairs: {} },
    conflicts: [],
    outbox: [],
  };
}

function stamp<T extends { version: number; createdAt: number; updatedAt: number; updatedBy: string }>(
  entity: T,
  now: number,
): T {
  entity.version = 1;
  entity.createdAt = now;
  entity.updatedAt = now;
  entity.updatedBy = DEVICE;
  return entity;
}

/** 首次使用：写入演示台账（工单 + 损伤点 + 修补记录） */
function seedLedger(): Ledger {
  const ledger = emptyLedger();
  const t = Date.now();

  const orders: WorkOrder[] = [
    {
      id: "ORD-106",
      boardBrand: "Burton 156",
      boardLength: "156cm",
      boardType: "全地域",
      edgeAngle: "侧刃88°，底刃1°",
      waxType: "低温蜡",
      customerPref: "偏好弱咬雪",
      status: "done",
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    },
    {
      id: "ORD-112",
      boardBrand: "竞速板165",
      boardLength: "165cm",
      boardType: "竞速板",
      edgeAngle: "侧刃87°，底刃0.5°",
      waxType: "待打蜡",
      customerPref: "—",
      status: "in_progress",
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    },
    {
      id: "ORD-118",
      boardBrand: "粉雪板158",
      boardLength: "158cm",
      boardType: "粉雪板",
      edgeAngle: "侧刃89°，底刃1.5°",
      waxType: "待打蜡",
      customerPref: "偏好弱咬雪",
      status: "pending",
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    },
  ];
  for (const o of orders) ledger.orders[o.id] = o;

  // ORD-112 的底板损伤与修补
  let seq = 0;
  const dmg1 = nextId(seq, "damage");
  seq = dmg1.seq;
  const damage = stamp(
    {
      id: dmg1.id,
      orderId: "ORD-112",
      location: "板头左侧划痕 12cm",
      kind: "划痕",
      size: "12cm",
      note: "旧数据升级补编号",
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    },
    t,
  );
  ledger.damages[damage.id] = damage;

  const rep1 = nextId(seq, "repair");
  seq = rep1.seq;
  const repair = stamp(
    {
      id: rep1.id,
      orderId: "ORD-112",
      damageId: damage.id,
      damageLocation: damage.location,
      material: "P-Tex",
      method: "热补",
      result: "待补",
      confirmed: false,
      invalid: false,
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    },
    t,
  );
  ledger.repairs[repair.id] = repair;
  ledger.seq = seq;

  // 补齐字段级时间戳
  for (const o of orders) {
    for (const f of ["boardBrand", "boardLength", "boardType", "edgeAngle", "waxType", "customerPref", "status"]) {
      ledger.fieldMeta[`order:${o.id}:${f}`] = { at: t, by: DEVICE };
    }
  }
  for (const f of ["location", "kind", "size", "note"]) {
    ledger.fieldMeta[`damage:${damage.id}:${f}`] = { at: t, by: DEVICE };
  }
  for (const f of ["damageId", "material", "method", "result", "confirmed"]) {
    ledger.fieldMeta[`repair:${repair.id}:${f}`] = { at: t, by: DEVICE };
  }

  ledger.synced = {
    orders: structuredClone(ledger.orders),
    damages: structuredClone(ledger.damages),
    repairs: structuredClone(ledger.repairs),
  };
  return ledger;
}

function isLedger(raw: unknown): raw is Ledger {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Ledger).schemaVersion === SCHEMA_VERSION &&
    typeof (raw as Ledger).orders === "object"
  );
}

/**
 * 旧数据升级：
 * - 老版本只有字符串数组 records（无 schemaVersion）→ 补编号、补版本、补字段时间戳
 * - 空本地台账 → 写入演示数据
 */
function migrateLegacy(raw: { records?: unknown }): Ledger {
  const ledger = emptyLedger();
  const t = Date.now();
  let seq = 0;

  const records = Array.isArray(raw.records) ? (raw.records as unknown[][]) : [];
  for (const rec of records) {
    const [id, board, edgeAngle, wax] = rec.map((v) => (v == null ? "" : String(v)));
    const orderId = id || `ORD-${String(records.indexOf(rec) + 1).padStart(3, "0")}`;
    const order: WorkOrder = {
      id: orderId,
      boardBrand: board || "未知雪板",
      boardLength: "",
      boardType: "",
      edgeAngle: edgeAngle || "",
      waxType: wax || "",
      customerPref: "",
      status: "pending",
      version: 1,
      createdAt: t,
      updatedAt: t,
      updatedBy: DEVICE,
    };
    ledger.orders[orderId] = order;
    for (const f of ["boardBrand", "boardLength", "boardType", "edgeAngle", "waxType", "customerPref", "status"]) {
      ledger.fieldMeta[`order:${orderId}:${f}`] = { at: t, by: DEVICE };
    }

    // 旧数据里的底板损伤文本 → 补稳定编号的损伤点
    if (edgeAngle.includes("损伤") || edgeAngle.includes("划痕") || wax.includes("补")) {
      const d = nextId(seq, "damage");
      seq = d.seq;
      const damage = stamp(
        {
          id: d.id,
          orderId,
          location: edgeAngle,
          kind: "旧数据损伤",
          size: "",
          note: "旧数据升级补编号",
          version: 1,
          createdAt: t,
          updatedAt: t,
          updatedBy: DEVICE,
        },
        t,
      );
      ledger.damages[damage.id] = damage;
      for (const f of ["location", "kind", "size", "note"]) {
        ledger.fieldMeta[`damage:${damage.id}:${f}`] = { at: t, by: DEVICE };
      }

      const r = nextId(seq, "repair");
      seq = r.seq;
      const repair = stamp(
        {
          id: r.id,
          orderId,
          damageId: damage.id,
          damageLocation: damage.location,
          material: "P-Tex",
          method: "待补",
          result: wax,
          confirmed: false,
          invalid: false,
          version: 1,
          createdAt: t,
          updatedAt: t,
          updatedBy: DEVICE,
        },
        t,
      );
      ledger.repairs[repair.id] = repair;
      for (const f of ["damageId", "material", "method", "result", "confirmed"]) {
        ledger.fieldMeta[`repair:${repair.id}:${f}`] = { at: t, by: DEVICE };
      }
    }
  }

  ledger.seq = seq;
  ledger.synced = {
    orders: structuredClone(ledger.orders),
    damages: structuredClone(ledger.damages),
    repairs: structuredClone(ledger.repairs),
  };
  return ledger;
}

export function migrate(raw: unknown): Ledger {
  if (isLedger(raw)) {
    // 已是当前版本：补齐可能缺失的字段
    const ledger = raw as Ledger;
    ledger.fieldMeta ??= {};
    ledger.conflicts ??= [];
    ledger.outbox ??= [];
    ledger.synced ??= { orders: {}, damages: {}, repairs: {} };
    return ledger;
  }
  if (raw && typeof raw === "object") {
    return migrateLegacy(raw as { records?: unknown });
  }
  return seedLedger();
}
