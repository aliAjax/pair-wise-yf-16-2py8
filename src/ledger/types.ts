// 台账核心数据模型：工单 / 底板损伤点 / 修补记录

export type OrderStatus = "pending" | "in_progress" | "done";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "待维护",
  in_progress: "进行中",
  done: "已完工",
};

/** 工单 */
export interface WorkOrder {
  id: string;
  boardBrand: string; // 雪板品牌
  boardLength: string; // 长度
  boardType: string; // 板型
  edgeAngle: string; // 刃角
  waxType: string; // 打蜡类型
  customerPref: string; // 客户偏好
  status: OrderStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

/** 底板损伤点（稳定编号，位置改动编号不变） */
export interface DamagePoint {
  id: string;
  orderId: string;
  location: string; // 损伤位置，如「板头左侧 12cm」
  kind: string; // 损伤类型：划痕 / 磕碰 / 脱层…
  size: string; // 尺寸
  note: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

/** 修补记录，必须关联真实损伤点 */
export interface RepairRecord {
  id: string;
  orderId: string;
  damageId: string; // 关联的真实损伤点编号
  damageLocation: string; // 关联损伤点的位置快照（作废/改号后依旧可查）
  material: string; // 修补材料：P-Tex / 金属腻子…
  method: string; // 修补方式
  result: string; // 修补结果
  confirmed: boolean; // 是否已确认
  confirmedAt?: number;
  /** 确认时关联损伤点的版本号；损伤点版本变大即作废 */
  confirmedDamageVersion?: number;
  invalid: boolean; // 是否因损伤点/材料改动作废
  invalidReason?: string;
  invalidatedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface FieldMeta {
  at: number;
  by: string;
}

export type EntityKind = "order" | "damage" | "repair";

/** 两处都改过的字段，各留一版待确认 */
export interface FieldConflict {
  id: string;
  kind: EntityKind;
  entityId: string;
  field: string;
  label: string;
  base: string;
  local: string;
  remote: string;
  localAt: number;
  remoteAt: number;
  createdAt: number;
}

/** 未提交批次的操作（可序列化，写盘失败后留住重试） */
export type Operation =
  | { op: "upsertOrder"; entity: WorkOrder }
  | { op: "deleteOrder"; id: string }
  | { op: "upsertDamage"; entity: DamagePoint }
  | { op: "deleteDamage"; id: string }
  | { op: "upsertRepair"; entity: RepairRecord }
  | { op: "deleteRepair"; id: string };

export interface PendingBatch {
  id: string;
  createdAt: number;
  attempts: number;
  label: string;
  ops: Operation[];
  error?: string;
}

export interface Ledger {
  schemaVersion: number;
  deviceId: string;
  seq: number;
  orders: Record<string, WorkOrder>;
  damages: Record<string, DamagePoint>;
  repairs: Record<string, RepairRecord>;
  /** 字段级时间戳，用于按字段合并与展示 */
  fieldMeta: Record<string, FieldMeta>;
  /** 上次同步基线（三方合并的 base） */
  synced: {
    orders: Record<string, WorkOrder>;
    damages: Record<string, DamagePoint>;
    repairs: Record<string, RepairRecord>;
  };
  conflicts: FieldConflict[];
  outbox: PendingBatch[];
}

export interface MergeResult {
  merged: Ledger;
  conflicts: FieldConflict[];
  changedCount: number;
}

export const SCHEMA_VERSION = 1;

/** 各实体参与字段合并的字段 */
export const MERGE_FIELDS: Record<EntityKind, string[]> = {
  order: [
    "boardBrand",
    "boardLength",
    "boardType",
    "edgeAngle",
    "waxType",
    "customerPref",
    "status",
  ],
  damage: ["location", "kind", "size", "note"],
  repair: ["damageId", "material", "method", "result", "confirmed"],
};

/** 字段中文名（冲突展示用） */
export const FIELD_LABELS: Record<string, string> = {
  boardBrand: "雪板品牌",
  boardLength: "长度",
  boardType: "板型",
  edgeAngle: "刃角",
  waxType: "打蜡类型",
  customerPref: "客户偏好",
  status: "完工状态",
  location: "损伤位置",
  kind: "损伤类型",
  size: "损伤尺寸",
  note: "备注",
  damageId: "关联损伤点",
  material: "修补材料",
  method: "修补方式",
  result: "修补结果",
  confirmed: "确认状态",
};
