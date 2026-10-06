// 本地台账核心类型定义
// 所有需要协同的字段统一用 Tracked 包装：携带最后写入者、时间、修订号与冲突信息。

export const SCHEMA_VERSION = 2;

/** 工单主表的字段键 */
export type FieldKey =
  | "orderNo"
  | "brand"
  | "lengthCm"
  | "boardType"
  | "edgeSideDeg"
  | "edgeBaseDeg"
  | "waxType"
  | "status"
  | "customer"
  | "preference";

export interface FieldDef {
  key: FieldKey;
  label: string;
  placeholder?: string;
  kind?: "text" | "number" | "select";
  options?: string[];
}

/** 工单层字段（中文标签 + 控件类型） */
export const FIELD_DEFS: FieldDef[] = [
  { key: "orderNo", label: "工单号", placeholder: "如 ORD-120" },
  { key: "brand", label: "雪板品牌", placeholder: "如 Burton / Salomon" },
  { key: "lengthCm", label: "长度(cm)", kind: "number", placeholder: "如 156" },
  {
    key: "boardType",
    label: "板型",
    kind: "select",
    options: ["全地域", "公园板", "竞速板", "粉雪板"],
  },
  { key: "edgeSideDeg", label: "侧刃角(°)", kind: "number", placeholder: "如 88" },
  { key: "edgeBaseDeg", label: "底刃角(°)", kind: "number", placeholder: "如 1" },
  { key: "waxType", label: "打蜡类型", placeholder: "如 低温蜡 / 全温蜡" },
  {
    key: "status",
    label: "工单状态",
    kind: "select",
    options: ["待维护", "维护中", "待交付", "已完工"],
  },
  { key: "customer", label: "客户", placeholder: "客户姓名或电话" },
  { key: "preference", label: "客户偏好", placeholder: "如 弱咬雪" },
];

export const DAMAGE_FIELD_KEYS = ["kind", "position", "sizeCm", "note", "status"] as const;
export type DamageFieldKey = (typeof DAMAGE_FIELD_KEYS)[number];

export const REPAIR_FIELD_KEYS = [
  "material",
  "method",
  "technician",
  "confirmed",
  "confirmNote",
] as const;
export type RepairFieldKey = (typeof REPAIR_FIELD_KEYS)[number];

/** 冲突候选版本 */
export interface Candidate {
  value: string;
  by: string; // 写入的设备
  at: number;
}

/** 字段冲突：双方都改过、值不一致时各留一版，待人工确认 */
export interface Conflict {
  candidates: Candidate[];
  resolvedValue?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

/** 被追踪的字段值 */
export interface Tracked {
  value: string;
  rev: number; // 最后一次改动所在的台账修订号
  by: string; // 最后写入设备
  at: number;
  conflict?: Conflict;
}

export interface Damage {
  id: string; // 稳定编号，如 D-001（工单内唯一，重开/升级不变）
  kind: Tracked;
  position: Tracked; // 底板位置，如 距板头 70cm 左侧
  sizeCm: Tracked; // 损伤尺寸 cm
  note: Tracked;
  status: Tracked; // 待修补 / 已修补
  /** 旧版数据升级前的原始位置描述，保证原位置照旧可查 */
  legacyPosition?: string;
  rev: number;
  addedBy: string;
  addedAt: number;
}

export interface Repair {
  id: string; // 稳定编号，如 R-001
  damageId: string; // 关联真实损伤点编号（可能为空字符串，表示旧数据未匹配上）
  material: Tracked; // 修补材料，如 P-Tex / 焊补条 / 补片
  method: Tracked;
  technician: Tracked;
  confirmed: Tracked; // 是 / 否
  confirmNote: Tracked; // 作废/重算说明
  /** 旧版数据中按文字位置记录的修补，升级后保留原文 */
  legacyPosition?: string;
  rev: number;
  addedBy: string;
  addedAt: number;
}

export interface OrderRecord {
  id: string;
  fields: Record<FieldKey, Tracked>;
  damages: Damage[];
  repairs: Repair[];
  seqDamage: number; // 已分配的损伤点序号
  seqRepair: number;
  createdAt: number;
  updatedAt: number;
}

export interface CommitEntry {
  id: string;
  changesetId: string;
  at: number;
  by: string;
  orderId: string;
  orderLabel: string;
  summary: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

/** 写盘台账文档 */
export interface LedgerDoc {
  version: number;
  rev: number; // 全局修订号，每落盘一个批次 +1
  seqOrder: number;
  orders: Record<string, OrderRecord>;
  /** 已应用的批次（幂等去重） */
  applied: Record<string, true>;
  log: CommitEntry[];
  devices: DeviceInfo[];
}

/* ---------------- 变更批次（changeset） ---------------- */

export interface SetFieldOp {
  kind: "setField";
  orderId: string;
  field: FieldKey;
  value: string;
  /** 本机编辑时依据的基线值（三路合并用），新增实体字段为 null */
  base: string | null;
}

export interface AddOrderOp {
  kind: "addOrder";
  localId: string; // 临时编号，落盘时换发稳定编号
  fields: Partial<Record<FieldKey, string>>;
}

export interface AddDamageOp {
  kind: "addDamage";
  orderId: string; // 可能是临时工单编号
  localId: string;
  data: Record<DamageFieldKey, string>;
}

export interface SetDamageFieldOp {
  kind: "setDamageField";
  orderId: string;
  damageId: string;
  field: DamageFieldKey;
  value: string;
  base: string | null;
}

export interface AddRepairOp {
  kind: "addRepair";
  orderId: string;
  localId: string;
  /** 可引用同批次中新增的临时损伤点编号，落盘时重映射 */
  damageLocalId: string | null;
  data: Partial<Record<RepairFieldKey, string>>;
}

export interface SetRepairFieldOp {
  kind: "setRepairField";
  orderId: string;
  repairId: string;
  field: RepairFieldKey;
  value: string;
  base: string | null;
}

export interface ResolveFieldOp {
  kind: "resolveField";
  orderId: string;
  field: FieldKey;
  value: string;
}
export interface ResolveDamageFieldOp {
  kind: "resolveDamageField";
  orderId: string;
  damageId: string;
  field: DamageFieldKey;
  value: string;
}
export interface ResolveRepairFieldOp {
  kind: "resolveRepairField";
  orderId: string;
  repairId: string;
  field: RepairFieldKey;
  value: string;
}

export type ChangesetOp =
  | SetFieldOp
  | AddOrderOp
  | AddDamageOp
  | SetDamageFieldOp
  | AddRepairOp
  | SetRepairFieldOp
  | ResolveFieldOp
  | ResolveDamageFieldOp
  | ResolveRepairFieldOp;

export interface Changeset {
  id: string;
  deviceId: string;
  deviceName: string;
  at: number;
  ops: ChangesetOp[];
}

/** 冲突定位：工单字段 / 损伤字段 / 修补字段 */
export type ConflictRef =
  | { scope: "field"; orderId: string; field: FieldKey }
  | { scope: "damage"; orderId: string; damageId: string; field: DamageFieldKey }
  | { scope: "repair"; orderId: string; repairId: string; field: RepairFieldKey };

/** 作废重算的修补定位与原因 */
export interface InvalidatedRef {
  orderId: string;
  repairId: string;
  reason: string;
}

/** 引擎应用批次后的产物 */
export interface ApplyResult {
  applied: boolean;
  /** 临时编号 → 稳定编号映射（供本机草稿换号） */
  orderIds: Record<string, string>;
  damageIds: Record<string, string>;
  repairIds: Record<string, string>;
  /** 本次合并出现字段冲突的位置（保存成功后提示并等待确认） */
  conflicts: ConflictRef[];
  /** 本次被作废重算的修补 */
  invalidatedRepairs: InvalidatedRef[];
}

export const TEMP_PREFIX = "tmp:";
export const isTempId = (id: string) => id.startsWith(TEMP_PREFIX);
export const newTempId = () => TEMP_PREFIX + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
