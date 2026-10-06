import { useEffect, useMemo, useState } from "react";
import {
  DamageFieldKey,
  FIELD_DEFS,
  FieldKey,
  OrderRecord,
  RepairFieldKey,
  Tracked,
  newTempId,
} from "../ledger/types";
import {
  Draft,
  NewDamage,
  NewRepair,
  draftIsDirty,
  startDraft,
} from "../ledger/store";
import { damageLabel, fieldLabel, formatTime, repairLabel } from "../ledger/ui-helpers";

const DAMAGE_KINDS = ["划痕", "凹伤", "烧板", "分层", "磕碰"];
const REPAIR_MATERIALS = ["P-Tex 透明", "P-Tex 黑色", "焊补条", "金属补片", "环氧胶"];
const STATUSES = ["待修补", "已修补"];

interface Props {
  order: OrderRecord | null;
  saveDraft: (draft: Draft) => {
    ok: boolean;
    orderId: string;
    draft: Draft;
    result: unknown;
  };
  onSaved: (orderId: string) => void;
  onCancel: () => void;
}

function Badge({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "ok" | "mute" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function conflictMark(t?: Tracked) {
  if (!t?.conflict) return null;
  const resolved = t.conflict.resolvedValue !== undefined;
  return (
    <span className={`conflict-dot ${resolved ? "is-resolved" : ""}`} title={resolved ? "已仲裁" : "双方修改冲突，待确认"}>
      {resolved ? "✓" : "⚠"}
    </span>
  );
}

export default function OrderEditor({ order, saveDraft, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => startDraft(order));
  const [attempted, setAttempted] = useState(false);

  // 切换工单时重建草稿
  useEffect(() => {
    setDraft(startDraft(order));
    setAttempted(false);
  }, [order]);

  const liveOrder = order; // 台账最新值，用于展示“对端已改成”
  const dirty = draftIsDirty(draft);

  const setField = (key: FieldKey, value: string) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));

  const setDamageEdit = (id: string, field: DamageFieldKey, value: string) =>
    setDraft((d) => ({
      ...d,
      damageEdits: { ...d.damageEdits, [id]: { ...d.damageEdits[id], [field]: value } },
    }));

  const setRepairEdit = (id: string, field: RepairFieldKey, value: string) =>
    setDraft((d) => ({
      ...d,
      repairEdits: { ...d.repairEdits, [id]: { ...d.repairEdits[id], [field]: value } },
    }));

  const addDamageRow = () => {
    const nd: NewDamage = {
      localId: newTempId(),
      data: { kind: "划痕", position: "", sizeCm: "", note: "", status: "待修补" },
    };
    setDraft((d) => ({ ...d, newDamages: [...d.newDamages, nd] }));
  };

  const setNewDamage = (localId: string, field: DamageFieldKey, value: string) =>
    setDraft((d) => ({
      ...d,
      newDamages: d.newDamages.map((x) =>
        x.localId === localId ? { ...x, data: { ...x.data, [field]: value } } : x,
      ),
    }));

  const removeNewDamage = (localId: string) =>
    setDraft((d) => ({
      ...d,
      newDamages: d.newDamages.filter((x) => x.localId !== localId),
      newRepairs: d.newRepairs.filter((r) => r.damageLocalId !== localId),
    }));

  const addRepairRow = () => {
    const nr: NewRepair = {
      localId: newTempId(),
      damageLocalId: null,
      data: { material: "", method: "", technician: "", confirmed: "否", confirmNote: "" },
    };
    setDraft((d) => ({ ...d, newRepairs: [...d.newRepairs, nr] }));
  };

  const setNewRepair = (localId: string, patch: Partial<NewRepair>) =>
    setDraft((d) => ({
      ...d,
      newRepairs: d.newRepairs.map((x) => (x.localId === localId ? { ...x, ...patch } : x)),
    }));

  const removeNewRepair = (localId: string) =>
    setDraft((d) => ({ ...d, newRepairs: d.newRepairs.filter((x) => x.localId !== localId) }));

  /** 修补记录可关联的真实损伤点：已存在的 + 同批次新增的 */
  const damageOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const d of liveOrder?.damages ?? []) {
      opts.push({ value: d.id, label: `${d.id} ${d.position.value || "位置未填"}` });
    }
    for (const nd of draft.newDamages) {
      opts.push({ value: nd.localId, label: `新损伤点 · ${nd.data.position || "位置未填"}` });
    }
    return opts;
  }, [liveOrder, draft.newDamages]);

  const handleSave = () => {
    setAttempted(true);
    if (!dirty) {
      onSaved(draft.orderId);
      return;
    }
    const r = saveDraft(draft);
    if (r.ok) {
      onSaved(r.orderId);
    }
  };

  const currentDamageValue = (id: string, field: DamageFieldKey): string =>
    draft.damageEdits[id]?.[field] ?? liveOrder?.damages.find((d) => d.id === id)?.[field].value ?? "";
  const currentRepairValue = (id: string, field: RepairFieldKey): string =>
    draft.repairEdits[id]?.[field] ?? liveOrder?.repairs.find((r) => r.id === id)?.[field].value ?? "";

  const otherSideHint = (t: Tracked | undefined, currentValue: string) => {
    const c = t?.conflict;
    if (!c) return null;
    const others = c.candidates.filter((x) => x.value !== currentValue);
    if (others.length === 0) return null;
    return (
      <small className="hint-conflict">
        对端版本：{others.map((x) => `「${x.value}」(${x.by} ${formatTime(x.at)})`).join(" / ")}
        ；保存后去顶部“待确认冲突”仲裁
      </small>
    );
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <h2>{draft.isNew ? "新建工单" : `编辑工单 ${liveOrder?.fields.orderNo.value || draft.orderId}`}</h2>
        <div className="row-actions">
          {dirty && <Badge tone="warn">有未保存改动</Badge>}
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={handleSave}>
            保存（按字段合并）
          </button>
        </div>
      </div>

      <section className="card">
        <h3>工单信息</h3>
        <div className="field-grid">
          {FIELD_DEFS.map((def) => {
            const tracked = liveOrder?.fields[def.key];
            const value = draft.fields[def.key] ?? "";
            return (
              <label className="field" key={def.key}>
                <span className="field-label">
                  {def.label} {conflictMark(tracked)}
                </span>
                {def.kind === "select" ? (
                  <select value={value} onChange={(e) => setField(def.key, e.target.value)}>
                    <option value="">请选择</option>
                    {def.options!.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={def.kind === "number" ? "number" : "text"}
                    value={value}
                    placeholder={def.placeholder}
                    onChange={(e) => setField(def.key, e.target.value)}
                  />
                )}
                {otherSideHint(tracked, value)}
              </label>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>底板损伤标记区 <small>损伤点带稳定编号，重开不变</small></h3>
          <button className="btn" onClick={addDamageRow}>＋ 新增损伤点</button>
        </div>

        <div className="damage-list">
          {(liveOrder?.damages ?? []).map((d) => {
            const invalidatedLinked = liveOrder?.repairs.some(
              (r) => r.damageId === d.id && /已作废/.test(r.confirmNote.value),
            );
            return (
              <article className="entity damage-entity" key={d.id}>
                <header>
                  <b className="stable-id">{d.id}</b>
                  {invalidatedLinked && <Badge tone="warn">关联修补已作废，待重算</Badge>}
                  {d.legacyPosition && <Badge tone="mute">旧台账位置可查：{d.legacyPosition}</Badge>}
                </header>
                <div className="mini-grid">
                  <label className="field">
                    <span className="field-label">损伤类型 {conflictMark(d.kind)}</span>
                    <select value={currentDamageValue(d.id, "kind")} onChange={(e) => setDamageEdit(d.id, "kind", e.target.value)}>
                      {DAMAGE_KINDS.map((k) => <option key={k}>{k}</option>)}
                    </select>
                    {otherSideHint(d.kind, currentDamageValue(d.id, "kind"))}
                  </label>
                  <label className="field field-wide">
                    <span className="field-label">底板位置 {conflictMark(d.position)}</span>
                    <input value={currentDamageValue(d.id, "position")} placeholder="如 距板头70cm 左侧"
                      onChange={(e) => setDamageEdit(d.id, "position", e.target.value)} />
                    {otherSideHint(d.position, currentDamageValue(d.id, "position"))}
                  </label>
                  <label className="field">
                    <span className="field-label">尺寸(cm) {conflictMark(d.sizeCm)}</span>
                    <input type="number" value={currentDamageValue(d.id, "sizeCm")}
                      onChange={(e) => setDamageEdit(d.id, "sizeCm", e.target.value)} />
                    {otherSideHint(d.sizeCm, currentDamageValue(d.id, "sizeCm"))}
                  </label>
                  <label className="field">
                    <span className="field-label">修补状态 {conflictMark(d.status)}</span>
                    <select value={currentDamageValue(d.id, "status")} onChange={(e) => setDamageEdit(d.id, "status", e.target.value)}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                    {otherSideHint(d.status, currentDamageValue(d.id, "status"))}
                  </label>
                  <label className="field field-wide">
                    <span className="field-label">备注 {conflictMark(d.note)}</span>
                    <input value={currentDamageValue(d.id, "note")}
                      onChange={(e) => setDamageEdit(d.id, "note", e.target.value)} />
                    {otherSideHint(d.note, currentDamageValue(d.id, "note"))}
                  </label>
                </div>
              </article>
            );
          })}

          {draft.newDamages.map((nd, i) => (
            <article className="entity is-new" key={nd.localId}>
              <header>
                <b className="stable-id">新损伤点 #{i + 1}</b>
                <Badge tone="info">保存后分配 D- 编号</Badge>
                <button className="btn btn-mini" onClick={() => removeNewDamage(nd.localId)}>移除</button>
              </header>
              <div className="mini-grid">
                <label className="field">
                  <span className="field-label">损伤类型</span>
                  <select value={nd.data.kind} onChange={(e) => setNewDamage(nd.localId, "kind", e.target.value)}>
                    {DAMAGE_KINDS.map((k) => <option key={k}>{k}</option>)}
                  </select>
                </label>
                <label className="field field-wide">
                  <span className="field-label">底板位置</span>
                  <input value={nd.data.position} placeholder="如 距板头70cm 左侧"
                    onChange={(e) => setNewDamage(nd.localId, "position", e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">尺寸(cm)</span>
                  <input type="number" value={nd.data.sizeCm}
                    onChange={(e) => setNewDamage(nd.localId, "sizeCm", e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">修补状态</span>
                  <select value={nd.data.status} onChange={(e) => setNewDamage(nd.localId, "status", e.target.value)}>
                    {STATUSES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </label>
                <label className="field field-wide">
                  <span className="field-label">备注</span>
                  <input value={nd.data.note} onChange={(e) => setNewDamage(nd.localId, "note", e.target.value)} />
                </label>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>修补记录 <small>必须关联真实损伤点</small></h3>
          <button className="btn" onClick={addRepairRow} disabled={damageOptions.length === 0}>
            ＋ 新增修补记录
          </button>
        </div>
        {damageOptions.length === 0 && (
          <p className="muted">请先登记并（连同工单一起）保存至少一个损伤点，再登记修补记录。</p>
        )}

        <div className="repair-list">
          {(liveOrder?.repairs ?? []).map((r) => {
            const linked = liveOrder?.damages.find((d) => d.id === r.damageId);
            const invalid = /已作废/.test(r.confirmNote.value);
            return (
              <article className="entity repair-entity" key={r.id}>
                <header>
                  <b className="stable-id">{r.id}</b>
                  {linked ? (
                    <Badge tone="ok">关联 {r.damageId} · {linked.position.value || "位置未填"}</Badge>
                  ) : (
                    <Badge tone="warn">
                      未关联到现存损伤点{r.legacyPosition ? `（旧记录：${r.legacyPosition}）` : ""}
                    </Badge>
                  )}
                  {r.confirmed.value === "是" && !invalid && <Badge tone="ok">已确认</Badge>}
                  {invalid && <Badge tone="warn">确认已作废</Badge>}
                </header>
                <div className="mini-grid">
                  <label className="field">
                    <span className="field-label">修补材料 {conflictMark(r.material)}</span>
                    <input list="repair-materials" value={currentRepairValue(r.id, "material")}
                      onChange={(e) => setRepairEdit(r.id, "material", e.target.value)} />
                    {otherSideHint(r.material, currentRepairValue(r.id, "material"))}
                  </label>
                  <label className="field">
                    <span className="field-label">修补方式 {conflictMark(r.method)}</span>
                    <input value={currentRepairValue(r.id, "method")} placeholder="如 热熔填补"
                      onChange={(e) => setRepairEdit(r.id, "method", e.target.value)} />
                    {otherSideHint(r.method, currentRepairValue(r.id, "method"))}
                  </label>
                  <label className="field">
                    <span className="field-label">技师 {conflictMark(r.technician)}</span>
                    <input value={currentRepairValue(r.id, "technician")}
                      onChange={(e) => setRepairEdit(r.id, "technician", e.target.value)} />
                    {otherSideHint(r.technician, currentRepairValue(r.id, "technician"))}
                  </label>
                  <label className="field">
                    <span className="field-label">确认 {conflictMark(r.confirmed)}</span>
                    <select value={currentRepairValue(r.id, "confirmed")}
                      onChange={(e) => setRepairEdit(r.id, "confirmed", e.target.value)}>
                      <option value="否">否（待确认）</option>
                      <option value="是">是（确认合格）</option>
                    </select>
                  </label>
                  <label className="field field-wide">
                    <span className="field-label">确认备注 {conflictMark(r.confirmNote)}</span>
                    <input value={currentRepairValue(r.id, "confirmNote")}
                      onChange={(e) => setRepairEdit(r.id, "confirmNote", e.target.value)} />
                  </label>
                </div>
                {invalid && <p className="invalid-note">{r.confirmNote.value}</p>}
              </article>
            );
          })}

          {draft.newRepairs.map((nr) => (
            <article className="entity is-new" key={nr.localId}>
              <header>
                <b className="stable-id">新修补记录</b>
                <Badge tone="info">保存后分配 R- 编号</Badge>
                <button className="btn btn-mini" onClick={() => removeNewRepair(nr.localId)}>移除</button>
              </header>
              <div className="mini-grid">
                <label className="field field-wide">
                  <span className="field-label">关联真实损伤点 *</span>
                  <select
                    value={nr.damageLocalId ?? ""}
                    onChange={(e) => setNewRepair(nr.localId, { damageLocalId: e.target.value || null })}
                  >
                    <option value="">请选择损伤点</option>
                    {damageOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">修补材料</span>
                  <input list="repair-materials" value={nr.data.material ?? ""}
                    onChange={(e) => setNewRepair(nr.localId, { data: { ...nr.data, material: e.target.value } })} />
                </label>
                <label className="field">
                  <span className="field-label">修补方式</span>
                  <input value={nr.data.method ?? ""}
                    onChange={(e) => setNewRepair(nr.localId, { data: { ...nr.data, method: e.target.value } })} />
                </label>
                <label className="field">
                  <span className="field-label">技师</span>
                  <input value={nr.data.technician ?? ""}
                    onChange={(e) => setNewRepair(nr.localId, { data: { ...nr.data, technician: e.target.value } })} />
                </label>
                <label className="field">
                  <span className="field-label">确认</span>
                  <select value={nr.data.confirmed ?? "否"}
                    onChange={(e) => setNewRepair(nr.localId, { data: { ...nr.data, confirmed: e.target.value } })}>
                    <option value="否">否（待确认）</option>
                    <option value="是">是（确认合格）</option>
                  </select>
                </label>
              </div>
              {attempted && !nr.damageLocalId && (
                <p className="invalid-note">修补记录必须关联一个真实损伤点。</p>
              )}
            </article>
          ))}
        </div>
      </section>

      <datalist id="repair-materials">
        {REPAIR_MATERIALS.map((m) => <option key={m} value={m} />)}
      </datalist>

      <p className="merge-note">
        保存时按字段三路合并：只有你改过的字段会提交；对方未动的直接并入，双方都改且不同的字段各留一版，
        到顶部“待确认冲突”里仲裁。损伤点或修补材料一旦改动，该损伤点下的已确认修补立即作废，打蜡资格随之重算。
      </p>
    </div>
  );
}
