import { useState } from 'react';
import { PALETTE, useStore } from '../../store/useStore';
import { mtConfirm } from '../../confirm';
import styles from './LineList.module.css';

export function LineList() {
  const lines = useStore((s) => s.lines);
  const lineOrder = useStore((s) => s.lineOrder);
  const stations = useStore((s) => s.stations);
  const activeLineId = useStore((s) => s.activeLineId);
  const addLine = useStore((s) => s.addLine);
  const removeLine = useStore((s) => s.removeLine);
  const renameLine = useStore((s) => s.renameLine);
  const recolorLine = useStore((s) => s.recolorLine);
  const setActiveLine = useStore((s) => s.setActiveLine);
  const resetAll = useStore((s) => s.resetAll);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);

  const stationCountFor = (lineId: string) => {
    let n = 0;
    for (const s of Object.values(stations)) {
      if (s.lineIds.includes(lineId)) n++;
    }
    return n;
  };

  const onConfirmDelete = async (id: string, name: string) => {
    if (await mtConfirm(`路線「${name}」を削除しますか？\nこの路線にしか属していない駅も一緒に削除されます。`, '削除')) {
      removeLine(id);
    }
  };

  const onConfirmReset = async () => {
    if (Object.keys(lines).length === 0 && Object.keys(stations).length === 0) {
      return;
    }
    if (await mtConfirm('全データをリセットしますか？この操作は元に戻せません。', 'リセット')) {
      resetAll();
    }
  };

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>路線</h2>
        <button
          className={styles.addBtn}
          onClick={() => addLine()}
          aria-label="路線を追加"
        >
          ＋ 追加
        </button>
      </div>

      <div className={styles.list}>
        {lineOrder.length === 0 && (
          <p className={styles.empty}>
            「＋ 追加」で最初の路線を作成しましょう
          </p>
        )}
        {lineOrder.map((lid) => {
          const line = lines[lid];
          if (!line) return null;
          const isActive = lid === activeLineId;
          const isEditing = editingId === lid;
          const count = stationCountFor(lid);
          return (
            <div
              key={lid}
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => !isEditing && setActiveLine(isActive ? null : lid)}
            >
              <button
                className={styles.swatch}
                style={{ background: line.color }}
                onClick={(e) => {
                  e.stopPropagation();
                  setColorPickerId(colorPickerId === lid ? null : lid);
                }}
                aria-label="色を変更"
              />
              {isEditing ? (
                <input
                  className={styles.nameInput}
                  defaultValue={line.name}
                  autoFocus
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v) renameLine(lid, v);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = (e.target as HTMLInputElement).value.trim();
                      if (v) renameLine(lid, v);
                      setEditingId(null);
                    } else if (e.key === 'Escape') {
                      setEditingId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className={styles.name}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(lid);
                  }}
                >
                  {line.name}
                </span>
              )}
              <span className={styles.count}>{count}</span>
              <button
                className={styles.removeBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onConfirmDelete(lid, line.name);
                }}
                aria-label="路線を削除"
                title="路線を削除"
              >
                ×
              </button>
              {colorPickerId === lid && (
                <div
                  className={styles.colorPicker}
                  onClick={(e) => e.stopPropagation()}
                >
                  {PALETTE.map((c) => (
                    <button
                      key={c}
                      className={styles.colorChoice}
                      style={{ background: c }}
                      onClick={() => {
                        recolorLine(lid, c);
                        setColorPickerId(null);
                      }}
                      aria-label={c}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.footer}>
        <button className={styles.resetBtn} onClick={onConfirmReset}>
          全データをリセット
        </button>
      </div>
    </aside>
  );
}
