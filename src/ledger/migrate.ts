import {
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
} from "./types";
import { createEmptyDoc, emptyTracked } from "./merge";

/**
 * 旧版数据升级。
 *
 * 兼容的旧台账（v1）形如：
 * {
 *   version: 1,
 *   orders: [
 *     { orderNo: "ORD-106", brand: "Burton", length: "156",
 *       baseDamage: "底板划痕12cm，距板头70cm左侧",
 *       repairs: "待补P-Tex" | [{ position: "距板头70cm", material: "P-Tex" }],
 *       edge: "侧刃88°，底刃1°", wax: "低温蜡", note: "..." }
 *   ]
 * }
 *
 * 升级保证：
 * - 工单、损伤点、修补记录全部补发稳定编号（ORD-/D-/R- 序列）；
 * - 全部字段包装成带版本信息的 Tracked（rev=0，标记为迁移数据）；
 * - 原损伤文字位置存入 legacyPosition，修补原位置文字存入 repair.legacyPosition，
 *   原有损伤与修复位置照旧可查；
 * - 修补尽量按位置文字关联到真实损伤点；匹配不上时 damageId 留空并保留原文，
 *   绝不臆造关联。
 */

const MIGRATED_BY = "旧数据升级";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function migTracked(v: unknown, at: number): Tracked {
  return emptyTracked(str(v), 0, MIGRATED_BY, at);
}

/** 从旧版自由文本里提取尺寸，如 “划痕12cm” */
function extractSizeCm(text: string): string {
  const m = text.match(/(\d+(?:\.\d+)?)\s*cm/i);
  return m ? m[1] : "";
}

/** 从 “侧刃88°，底刃1°” 这类旧文本提取角度 */
function extractDeg(text: string, which: "侧刃" | "底刃"): string {
  const m = text.match(new RegExp(`${which}\\s*(\\d+(?:\\.\\d+)?)\\s*°`));
  return m ? m[1] : "";
}

function normalizePos(s: string): string {
  return s.replace(/[\s，,。.、（）()]/g, "");
}

/** 旧修补记录按文字位置关联真实损伤点 */
function matchDamageByPosition(
  repairPos: string,
  damages: Damage[],
): string {
  const needle = normalizePos(repairPos);
  if (needle.length < 2) return "";
  const needleNums = needle.match(/\d+/g) ?? [];
  let best: Damage | null = null;
  let bestScore = 0;
  for (const d of damages) {
    const hay = normalizePos(d.legacyPosition || d.position.value);
    if (!hay) continue;
    // 双向包含计分，长串命中得分更高
    let score = 0;
    if (hay.includes(needle)) score = needle.length;
    else if (needle.includes(hay)) score = hay.length;
    if (score === 0) continue;
    // 双方都带数字时，数字必须对得上（避免“距板头70cm”误关联到“距板尾90cm”）
    const hayNums: string[] = hay.match(/\d+/g) ?? [];
    if (needleNums.length > 0 && hayNums.length > 0) {
      const shared = needleNums.some((n) => hayNums.includes(n));
      if (!shared) continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  // 至少命中 2 个归一化字符（且通过数字一致性）才采信
  return bestScore >= 2 && best ? best.id : "";
}

interface LegacyShape {
  version?: number;
  orders?: unknown;
}

export function migrate(raw: unknown): { doc: LedgerDoc; migrated: boolean } {
  const legacy = asRecord(raw) as LegacyShape | null;
  if (!legacy || legacy.version === SCHEMA_VERSION) {
    if (legacy && legacy.version === SCHEMA_VERSION) {
      return { doc: raw as LedgerDoc, migrated: false };
    }
    return { doc: createEmptyDoc(), migrated: true };
  }

  const doc = createEmptyDoc();
  const now = Date.now();
  const list = Array.isArray(legacy.orders) ? legacy.orders : [];

  for (const itemRaw of list) {
    const item = asRecord(itemRaw);
    if (!item) continue;

    doc.seqOrder += 1;
    const orderId = `ORD-${String(doc.seqOrder).padStart(3, "0")}`;

    // 旧字段 → 新主表字段
    const edgeText = str(item.edge ?? item.edgeAngle);
    const supplied: Partial<Record<FieldKey, string>> = {
      orderNo: str(item.orderNo ?? item.no) || orderId,
      brand: str(item.brand),
      lengthCm: str(item.lengthCm ?? item.length),
      boardType: str(item.boardType ?? item.type),
      edgeSideDeg: extractDeg(edgeText, "侧刃"),
      edgeBaseDeg: extractDeg(edgeText, "底刃"),
      waxType: str(item.waxType ?? item.wax),
      status: str(item.status),
      customer: str(item.customer),
      preference: str(item.preference ?? item.note),
    };

    const fields = {} as Record<FieldKey, Tracked>;
    for (const def of FIELD_DEFS) {
      fields[def.key] = migTracked(supplied[def.key] ?? "", now);
    }

    const order: OrderRecord = {
      id: orderId,
      fields,
      damages: [],
      repairs: [],
      seqDamage: 0,
      seqRepair: 0,
      createdAt: now,
      updatedAt: now,
    };

    // 旧底板损伤：可能是字符串、字符串数组、对象数组
    const damageTexts: string[] = [];
    const collectDamageText = (t: string) => {
      const parts = t.split(/[;；\n]+/).map((s) => s.trim()).filter(Boolean);
      damageTexts.push(...(parts.length ? parts : [t]));
    };
    const rawDamage = item.baseDamage ?? item.damage ?? item.damages;
    if (typeof rawDamage === "string" && rawDamage.trim()) {
      collectDamageText(rawDamage.trim());
    } else if (Array.isArray(rawDamage)) {
      for (const d of rawDamage) {
        const rec = asRecord(d);
        if (rec) {
          const text = str(rec.position ?? rec.desc ?? rec.text ?? rec.baseDamage);
          if (text) damageTexts.push(text);
        } else if (typeof d === "string" && d.trim()) {
          damageTexts.push(d.trim());
        }
      }
    }

    for (const text of damageTexts) {
      order.seqDamage += 1;
      const id = `D-${String(order.seqDamage).padStart(3, "0")}`;
      const mk = (v: string): Tracked => migTracked(v, now);
      const size = extractSizeCm(text);
      order.damages.push({
        id,
        kind: mk(/划痕|刮伤/.test(text) ? "划痕" : /凹/.test(text) ? "凹伤" : "底板损伤"),
        position: mk(text),
        sizeCm: mk(size),
        note: mk(""),
        status: mk("待修补"),
        legacyPosition: text,
        rev: 0,
        addedBy: MIGRATED_BY,
        addedAt: now,
      });
    }

    // 旧修补记录：字符串（如 “待补P-Tex”）/ 对象数组
    type LegacyRepair = { pos: string; material: string; method: string; tech: string; raw: string };
    const legacyRepairs: LegacyRepair[] = [];
    const rawRepairs = item.repairs ?? item.repair ?? item.repairLog;
    const pushRepair = (rec: Record<string, unknown> | null, text: string) => {
      // 只有结构化记录上的 position 字段才算位置线索；
      // 纯文本（如“待补P-Tex”）是状态/材料描述，不参与位置匹配。
      legacyRepairs.push({
        pos: rec ? str(rec.position ?? rec.pos ?? rec.location) : "",
        material: str(rec?.material ?? (text ? (/P-?Tex/i.test(text) ? "P-Tex" : "") : "")),
        method: str(rec?.method ?? ""),
        tech: str(rec?.technician ?? rec?.tech ?? ""),
        raw: text,
      });
    };
    if (typeof rawRepairs === "string" && rawRepairs.trim()) {
      pushRepair(null, rawRepairs.trim());
    } else if (Array.isArray(rawRepairs)) {
      for (const r of rawRepairs) {
        const rec = asRecord(r);
        if (rec) pushRepair(rec, "");
        else if (typeof r === "string" && r.trim()) pushRepair(null, r.trim());
      }
    }

    for (const lr of legacyRepairs) {
      order.seqRepair += 1;
      const id = `R-${String(order.seqRepair).padStart(3, "0")}`;
      const mk = (v: string): Tracked => migTracked(v, now);
      let damageId = matchDamageByPosition(lr.pos, order.damages);
      // 只有旧修补没有任何位置线索时，才在“唯一损伤点”的工单上兜底关联；
      // 明确写了位置但匹配不上的，绝不臆造关联（原文仍保留，待人工处理）。
      if (!damageId && !lr.pos && order.damages.length === 1) damageId = order.damages[0].id;
      const repair: Repair = {
        id,
        damageId,
        material: mk(lr.material),
        method: mk(lr.method),
        technician: mk(lr.tech),
        confirmed: mk("否"), // 迁移数据一律需要重新确认
        confirmNote: mk(""),
        rev: 0,
        addedBy: MIGRATED_BY,
        addedAt: now,
      };
      // 纯文本旧记录（如“待补P-Tex”）或带备注的旧记录，原文保留在备注中照旧可查
      if (lr.raw) repair.confirmNote = mk(`旧台账原文：${lr.raw}`);
      const legacyPos = lr.pos || lr.raw;
      if (legacyPos) repair.legacyPosition = legacyPos;
      order.repairs.push(repair);
    }

    doc.orders[orderId] = order;
  }

  doc.version = SCHEMA_VERSION;
  return { doc, migrated: true };
}

/** 防御性补齐：即便已是 v2 文档，也补齐缺失编号/字段，保证结构完整 */
export function ensureShape(doc: LedgerDoc): LedgerDoc {
  let seqOrder = 0;
  for (const order of Object.values(doc.orders)) {
    const m = /^ORD-(\d+)$/.exec(order.id);
    if (m) seqOrder = Math.max(seqOrder, Number(m[1]));
    for (const def of FIELD_DEFS) {
      if (!order.fields[def.key]) {
        order.fields[def.key] = emptyTracked("", doc.rev, "结构补齐", Date.now());
      }
    }
    let seqD = order.seqDamage ?? 0;
    for (const d of order.damages) {
      const dm = /^D-(\d+)$/.exec(d.id);
      if (dm) seqD = Math.max(seqD, Number(dm[1]));
      const need: DamageFieldKey[] = ["kind", "position", "sizeCm", "note", "status"];
      for (const f of need) if (!d[f]) d[f] = emptyTracked("", doc.rev, "结构补齐", Date.now());
    }
    order.seqDamage = seqD;
    let seqR = order.seqRepair ?? 0;
    for (const r of order.repairs) {
      const rm = /^R-(\d+)$/.exec(r.id);
      if (rm) seqR = Math.max(seqR, Number(rm[1]));
      const need: RepairFieldKey[] = ["material", "method", "technician", "confirmed", "confirmNote"];
      for (const f of need) if (!r[f]) r[f] = emptyTracked("", doc.rev, "结构补齐", Date.now());
    }
    order.seqRepair = seqR;
  }
  doc.seqOrder = Math.max(doc.seqOrder ?? 0, seqOrder);
  doc.applied ??= {};
  doc.log ??= [];
  doc.devices ??= [];
  doc.version = SCHEMA_VERSION;
  return doc;
}
