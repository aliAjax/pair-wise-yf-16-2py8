import { ChangesetOp, DamageFieldKey, FieldKey, LedgerDoc, RepairFieldKey } from "../ledger/types";
import { collectConflicts, describeConflict, formatTime } from "../ledger/ui-helpers";

interface Props {
  doc: LedgerDoc;
  onResolve: (ops: ChangesetOp[]) => void;
}

/** 全局字段冲突收件箱：双方都改过的字段在这里逐字段仲裁 */
export default function ConflictPanel({ doc, onResolve }: Props) {
  const conflicts = collectConflicts(doc);
  if (conflicts.length === 0) {
    return <p className="muted">当前没有待确认的字段冲突。</p>;
  }

  const choose = (index: number, value: string) => {
    const ref = conflicts[index].ref;
    if (ref.scope === "field") {
      const op: ChangesetOp = { kind: "resolveField", orderId: ref.orderId, field: ref.field as FieldKey, value };
      onResolve([op]);
    } else if (ref.scope === "damage") {
      const op: ChangesetOp = {
        kind: "resolveDamageField",
        orderId: ref.orderId,
        damageId: ref.damageId,
        field: ref.field as DamageFieldKey,
        value,
      };
      onResolve([op]);
    } else {
      const op: ChangesetOp = {
        kind: "resolveRepairField",
        orderId: ref.orderId,
        repairId: ref.repairId,
        field: ref.field as RepairFieldKey,
        value,
      };
      onResolve([op]);
    }
  };

  return (
    <div className="conflict-list">
      {conflicts.map((c, i) => {
        const t = c.tracked;
        const con = t.conflict!;
        const resolved = con.resolvedValue;
        return (
          <article key={`${i}-${describeConflict(doc, c.ref)}`} className={`conflict-card ${resolved !== undefined ? "is-resolved" : ""}`}>
            <div className="conflict-title">
              {describeConflict(doc, c.ref)}
              {resolved !== undefined && <span className="badge badge-ok">已采用：{resolved}</span>}
            </div>
            <div className="candidate-list">
              {/* 当前值（缺省展示在最前） */}
              <button
                className={`candidate ${resolved === t.value ? "chosen" : ""}`}
                onClick={() => choose(i, t.value)}
              >
                <b>「{t.value || "（空）"}」</b>
                <small>现值 · {t.by} · {formatTime(t.at)}</small>
              </button>
              {con.candidates
                .filter((x) => x.value !== t.value)
                .map((x, j) => (
                  <button
                    key={j}
                    className={`candidate ${resolved === x.value ? "chosen" : ""}`}
                    onClick={() => choose(i, x.value)}
                  >
                    <b>「{x.value || "（空）"}」</b>
                    <small>{x.by} · {formatTime(x.at)}</small>
                  </button>
                ))}
            </div>
            <small className="muted">点选一个版本即完成该字段仲裁；仲裁值会以新批次写盘并同步到另一台平板。</small>
          </article>
        );
      })}
    </div>
  );
}
