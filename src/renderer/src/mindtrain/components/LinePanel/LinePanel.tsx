import { useState } from 'react';
import { PALETTE, useStore } from '../../store/useStore';
import { TRAIN_SHAPES, type TrainShape } from '../../types';
import { renderTrainShape } from '../Canvas/shapes';
import styles from './LinePanel.module.css';

const TRAIN_SHAPE_LABELS: Record<TrainShape, string> = {
  capsule: 'カプセル',
  arrow: '矢印',
  double: '2 両',
  circle: '丸',
};

export function LinePanel() {
  const lines = useStore((s) => s.lines);
  const stations = useStore((s) => s.stations);
  const trains = useStore((s) => s.trains);
  const trainOrder = useStore((s) => s.trainOrder);
  const activeLineId = useStore((s) => s.activeLineId);
  const selectStation = useStore((s) => s.selectStation);
  const recolorLine = useStore((s) => s.recolorLine);
  const addTrain = useStore((s) => s.addTrain);
  const renameTrain = useStore((s) => s.renameTrain);
  const setTrainColor = useStore((s) => s.setTrainColor);
  const setTrainShape = useStore((s) => s.setTrainShape);
  const removeTrain = useStore((s) => s.removeTrain);
  const pickingTrainEndpoint = useStore((s) => s.pickingTrainEndpoint);
  const startPickingTrainEndpoint = useStore(
    (s) => s.startPickingTrainEndpoint
  );
  const cancelPickingTrainEndpoint = useStore(
    (s) => s.cancelPickingTrainEndpoint
  );

  const [editingTrainId, setEditingTrainId] = useState<string | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<
    | { kind: 'line'; id: string }
    | { kind: 'train'; id: string }
    | null
  >(null);
  const [trainsExpanded, setTrainsExpanded] = useState(true);

  const line = activeLineId ? lines[activeLineId] : null;

  if (!line) {
    return (
      <aside className={styles.panel}>
        <div className={styles.empty}>
          <p>路線を選択すると詳細が表示されます</p>
          <p className={styles.emptyHint}>
            左パネルの路線をクリック、または駅をクリックして編集
          </p>
        </div>
      </aside>
    );
  }

  const sList = line.stationIds
    .map((id) => stations[id])
    .filter(Boolean);
  const stationCount = sList.length;
  const segmentCount = Math.max(0, stationCount - 1);
  const terminusCount = stationCount >= 2 ? 2 : stationCount;
  const lineTrains = trainOrder
    .map((tid) => trains[tid])
    .filter((t) => t && t.lineId === line.id);
  const hasOpenSegment = (() => {
    let run = 0;
    for (const st of sList) {
      if (st.status === 'done') {
        run++;
        if (run >= 2) return true;
      } else {
        run = 0;
      }
    }
    return false;
  })();

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>ルート</h2>
      </div>

      <div className={styles.body}>
        <div className={styles.lineCard}>
          <button
            className={styles.lineDot}
            style={{ background: line.color }}
            onClick={() =>
              setColorPickerFor((cur) =>
                cur && cur.kind === 'line' && cur.id === line.id
                  ? null
                  : { kind: 'line', id: line.id }
              )
            }
            aria-label="路線色を変更"
            title="路線色を変更"
          />
          <span className={styles.lineName}>{line.name}</span>
          {colorPickerFor?.kind === 'line' &&
            colorPickerFor.id === line.id && (
              <div className={styles.colorPicker}>
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    className={styles.colorChoice}
                    style={{ background: c }}
                    onClick={() => {
                      recolorLine(line.id, c);
                      setColorPickerFor(null);
                    }}
                    aria-label={c}
                  />
                ))}
              </div>
            )}
        </div>

        <div className={styles.stats}>
          <div className={styles.statsRow}>
            <span className={styles.statValue}>{stationCount}駅</span>
            <span className={styles.statSep}>・</span>
            <span className={styles.statValue}>
              {segmentCount}つのセグメント
            </span>
          </div>
          <div className={styles.statsSub}>{terminusCount}つの端子</div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <button
              className={styles.sectionToggle}
              onClick={() => setTrainsExpanded((v) => !v)}
              aria-expanded={trainsExpanded}
            >
              <span
                className={styles.toggleArrow}
                data-expanded={trainsExpanded ? 'true' : 'false'}
              >
                ▾
              </span>
              <span className={styles.sectionTitle}>電車</span>
              {lineTrains.length > 0 && (
                <span className={styles.sectionCount}>
                  {lineTrains.length}
                </span>
              )}
            </button>
            <button
              className={styles.addBtn}
              onClick={() => {
                addTrain(line.id);
                setTrainsExpanded(true);
              }}
              title={
                hasOpenSegment
                  ? '開業区間を走る電車を追加'
                  : '開業区間がないとまだ走りません'
              }
            >
              ＋ 追加
            </button>
          </div>
          {!trainsExpanded ? null : lineTrains.length === 0 ? (
            <p className={styles.emptyHint}>
              {hasOpenSegment
                ? '電車を追加すると開業区間で走らせられます'
                : '駅を「開業」にすると電車が走り始めます'}
            </p>
          ) : (
            <div className={styles.trainList}>
              {lineTrains.map((train) => {
                const isEditing = editingTrainId === train.id;
                const fromIdx = line.stationIds.indexOf(train.fromStationId);
                const toIdx = line.stationIds.indexOf(train.toStationId);
                const validRange =
                  fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx;
                return (
                  <div
                    key={train.id}
                    className={styles.trainRow}
                    style={{ borderColor: line.color }}
                  >
                    <div className={styles.trainHeader}>
                      <button
                        className={styles.trainGlyph}
                        style={{ background: train.color ?? line.color }}
                        onClick={() =>
                          setColorPickerFor((cur) =>
                            cur && cur.kind === 'train' && cur.id === train.id
                              ? null
                              : { kind: 'train', id: train.id }
                          )
                        }
                        aria-label="電車の色を変更"
                        title="電車の色を変更"
                      />
                      {colorPickerFor?.kind === 'train' &&
                        colorPickerFor.id === train.id && (
                          <div className={styles.trainColorPicker}>
                            <button
                              className={`${styles.colorChoice} ${styles.colorChoiceReset}`}
                              onClick={() => {
                                setTrainColor(train.id, null);
                                setColorPickerFor(null);
                              }}
                              aria-label="路線色にリセット"
                              title="路線色にリセット"
                            >
                              ↺
                            </button>
                            {PALETTE.map((c) => (
                              <button
                                key={c}
                                className={styles.colorChoice}
                                style={{ background: c }}
                                onClick={() => {
                                  setTrainColor(train.id, c);
                                  setColorPickerFor(null);
                                }}
                                aria-label={c}
                              />
                            ))}
                          </div>
                        )}
                      {isEditing ? (
                        <input
                          className={styles.trainNameInput}
                          defaultValue={train.name}
                          autoFocus
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v) renameTrain(train.id, v);
                            setEditingTrainId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) renameTrain(train.id, v);
                              setEditingTrainId(null);
                            } else if (e.key === 'Escape') {
                              setEditingTrainId(null);
                            }
                          }}
                        />
                      ) : (
                        <span
                          className={styles.trainName}
                          onDoubleClick={() => setEditingTrainId(train.id)}
                          title="ダブルクリックでリネーム"
                        >
                          {train.name}
                        </span>
                      )}
                      <button
                        className={styles.trainEdit}
                        onClick={() => setEditingTrainId(train.id)}
                        aria-label="リネーム"
                        title="リネーム"
                      >
                        ✎
                      </button>
                      <button
                        className={styles.trainRemove}
                        onClick={() => removeTrain(train.id)}
                        aria-label="削除"
                        title="削除"
                      >
                        ×
                      </button>
                    </div>
                    <div className={styles.trainRange}>
                      {(() => {
                        const fromSt = stations[train.fromStationId];
                        const toSt = stations[train.toStationId];
                        const isPickingFrom =
                          pickingTrainEndpoint?.trainId === train.id &&
                          pickingTrainEndpoint.endpoint === 'from';
                        const isPickingTo =
                          pickingTrainEndpoint?.trainId === train.id &&
                          pickingTrainEndpoint.endpoint === 'to';
                        return (
                          <>
                            <button
                              className={`${styles.rangeBtn} ${
                                isPickingFrom ? styles.rangeBtnActive : ''
                              }`}
                              onClick={() => {
                                if (isPickingFrom) {
                                  cancelPickingTrainEndpoint();
                                } else {
                                  startPickingTrainEndpoint(train.id, 'from');
                                }
                              }}
                              title="クリック後、キャンバスで駅を選択"
                            >
                              {isPickingFrom
                                ? '駅をクリック…'
                                : (fromSt?.name ?? '未選択')}
                            </button>
                            <span className={styles.rangeArrow}>→</span>
                            <button
                              className={`${styles.rangeBtn} ${
                                isPickingTo ? styles.rangeBtnActive : ''
                              }`}
                              onClick={() => {
                                if (isPickingTo) {
                                  cancelPickingTrainEndpoint();
                                } else {
                                  startPickingTrainEndpoint(train.id, 'to');
                                }
                              }}
                              title="クリック後、キャンバスで駅を選択"
                            >
                              {isPickingTo
                                ? '駅をクリック…'
                                : (toSt?.name ?? '未選択')}
                            </button>
                            {!validRange && (
                              <span className={styles.rangeWarn}>
                                範囲を 2 駅以上に
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <div className={styles.trainShapeRow}>
                      {TRAIN_SHAPES.map((sh) => {
                        const active = (train.shape ?? 'capsule') === sh;
                        const fillColor = train.color ?? line.color;
                        return (
                          <button
                            key={sh}
                            className={`${styles.trainShapeBtn} ${
                              active ? styles.trainShapeBtnActive : ''
                            }`}
                            onClick={() => setTrainShape(train.id, sh)}
                            title={TRAIN_SHAPE_LABELS[sh]}
                            aria-label={TRAIN_SHAPE_LABELS[sh]}
                          >
                            <svg width={26} height={14} viewBox="-13 -7 26 14">
                              {renderTrainShape({
                                shape: sh,
                                fill: fillColor,
                                stroke: '#ffffff',
                                strokeWidth: 1.2,
                              })}
                            </svg>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>駅</span>
          <div className={styles.stationList}>
            {sList.length === 0 && (
              <p className={styles.emptyHint}>
                配置モードで路線に駅を追加してください
              </p>
            )}
            {sList.map((st, i) => {
              const isFirst = i === 0;
              const isLast = i === sList.length - 1;
              const isTransfer = st.lineIds.length >= 2;
              const planned = st.status === 'todo';
              const stroke = isTransfer ? '#1a1d22' : line.color;
              return (
                <button
                  key={st.id}
                  className={styles.stationRow}
                  onClick={() => selectStation(st.id)}
                >
                  <svg
                    className={styles.stationIcon}
                    width={18}
                    height={32}
                    viewBox="0 0 18 32"
                    aria-hidden="true"
                  >
                    {!isFirst && (
                      <line
                        x1={9}
                        y1={0}
                        x2={9}
                        y2={11}
                        stroke={line.color}
                        strokeWidth={3}
                      />
                    )}
                    {!isLast && (
                      <line
                        x1={9}
                        y1={21}
                        x2={9}
                        y2={32}
                        stroke={line.color}
                        strokeWidth={3}
                      />
                    )}
                    <rect
                      x={3}
                      y={11}
                      width={12}
                      height={10}
                      rx={2}
                      fill="#ffffff"
                      stroke={stroke}
                      strokeWidth={2}
                      strokeDasharray={planned ? '3 2' : undefined}
                      opacity={planned ? 0.7 : 1}
                    />
                  </svg>
                  <span
                    className={`${styles.stationName} ${
                      planned ? styles.stationPlanned : ''
                    }`}
                  >
                    {st.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
