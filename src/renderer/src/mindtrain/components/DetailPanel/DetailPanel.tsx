import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PALETTE, useStore } from '../../store/useStore';
import {
  STATION_SHAPES,
  type StationShape,
  type StationStatus,
} from '../../types';
import { renderStationShape } from '../Canvas/shapes';
import { useApp } from '../../../store';
import type { CanvasCard } from '../../../types';
import { mtConfirm } from '../../confirm';
import styles from './DetailPanel.module.css';

const STATUS_OPTIONS: { value: StationStatus; label: string }[] = [
  { value: 'todo', label: '計画中' },
  { value: 'doing', label: '建設中' },
  { value: 'done', label: '開業' },
];

const SHAPE_LABELS: Record<StationShape, string> = {
  'rounded-square': '角丸',
  circle: '円',
  square: '四角',
  diamond: 'ダイヤ',
  hexagon: '六角',
  triangle: '三角',
};

export function DetailPanel() {
  const selectedStationId = useStore((s) => s.selectedStationId);
  const stations = useStore((s) => s.stations);
  const lines = useStore((s) => s.lines);
  const renameStation = useStore((s) => s.renameStation);
  const updateStationNotes = useStore((s) => s.updateStationNotes);
  const setStationStatus = useStore((s) => s.setStationStatus);
  const addStationLink = useStore((s) => s.addStationLink);
  const removeStationLink = useStore((s) => s.removeStationLink);
  const detachStationFromLine = useStore((s) => s.detachStationFromLine);
  const setStationShape = useStore((s) => s.setStationShape);
  const setStationColor = useStore((s) => s.setStationColor);
  const removeStation = useStore((s) => s.removeStation);
  const selectStation = useStore((s) => s.selectStation);
  const setStationCard = useStore((s) => s.setStationCard);

  // Constella store + router, for linking a station to a canvas card and jumping.
  const navigate = useNavigate();
  const { state: cstate, dispatch: cdispatch } = useApp();

  const station = selectedStationId ? stations[selectedStationId] : null;

  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [cardQuery, setCardQuery] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (station) {
      setLinkUrl('');
      setLinkLabel('');
      setColorPickerOpen(false);
      setCardQuery('');
    }
  }, [station?.id]);

  if (!station) {
    return (
      <aside className={styles.panel}>
        <div className={styles.empty}>
          <p>駅を選択すると詳細が表示されます</p>
          <p className={styles.emptyHint}>
            キャンバス上の駅をクリックしてください
          </p>
        </div>
      </aside>
    );
  }

  const onAddLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    addStationLink(station.id, url, linkLabel.trim() || url);
    setLinkUrl('');
    setLinkLabel('');
  };

  const onRemoveStation = async () => {
    if (await mtConfirm(`駅「${station.name}」を削除しますか？`, '削除')) {
      removeStation(station.id);
    }
  };

  const onDetachLine = async (lineId: string) => {
    if (station.lineIds.length === 1) {
      if (
        !(await mtConfirm(
          'この駅を最後の路線から外すと駅自体が削除されます。続行しますか？',
          '続行'
        ))
      ) {
        return;
      }
    }
    detachStationFromLine(station.id, lineId);
  };

  // 関連カード（駅 ↔ Constella カードの相互リンク）
  const linkedCard = station.cardId ? cstate.canvasCards.find((c) => c.id === station.cardId) : null;
  const linkCard = (c: CanvasCard) => {
    setStationCard(station.id, c.id);
    cdispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...c, stationId: station.id } });
    setCardQuery('');
  };
  const unlinkCard = () => {
    setStationCard(station.id, null);
    if (linkedCard) cdispatch({ type: 'UPDATE_CANVAS_CARD', payload: { ...linkedCard, stationId: undefined } });
  };
  const cardMatches = cardQuery.trim()
    ? cstate.canvasCards
        .filter((c) => (c.title || c.content || '').toLowerCase().includes(cardQuery.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.title}>駅の詳細</h2>
        <button
          className={styles.closeBtn}
          onClick={() => selectStation(null)}
          aria-label="閉じる"
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>駅名（タスク名）</span>
          <input
            ref={nameInputRef}
            className={styles.input}
            value={station.name}
            onChange={(e) => renameStation(station.id, e.target.value)}
          />
        </label>

        <div className={styles.field}>
          <span className={styles.label}>状態</span>
          <div className={styles.statusGroup}>
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`${styles.statusBtn} ${
                  station.status === opt.value ? styles.statusActive : ''
                }`}
                data-status={opt.value}
                onClick={() => setStationStatus(station.id, opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>シェイプ</span>
          <div className={styles.shapeGroup}>
            {STATION_SHAPES.map((sh) => {
              const active = (station.shape ?? 'rounded-square') === sh;
              return (
                <button
                  key={sh}
                  className={`${styles.shapeBtn} ${
                    active ? styles.shapeBtnActive : ''
                  }`}
                  onClick={() => setStationShape(station.id, sh)}
                  title={SHAPE_LABELS[sh]}
                  aria-label={SHAPE_LABELS[sh]}
                >
                  <svg width={20} height={20} viewBox="-12 -12 24 24">
                    {renderStationShape({
                      shape: sh,
                      cx: 0,
                      cy: 0,
                      size: 16,
                      fill: '#ffffff',
                      stroke: 'currentColor',
                      strokeWidth: 2.5,
                    })}
                  </svg>
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>色</span>
          <div className={styles.stationColorRow}>
            <button
              className={styles.stationColorSwatch}
              style={{
                background:
                  station.color ??
                  (station.lineIds.length >= 2
                    ? 'var(--ink)'
                    : (lines[station.lineIds[0]]?.color ?? '#888')),
              }}
              onClick={() => setColorPickerOpen((v) => !v)}
              aria-label="色を変更"
              title="色を変更"
            />
            <span className={styles.stationColorHint}>
              {station.color ? '個別指定' : '路線色 / 乗換墨'}
            </span>
            {station.color && (
              <button
                className={styles.stationColorReset}
                onClick={() => setStationColor(station.id, null)}
              >
                ↺ リセット
              </button>
            )}
          </div>
          {colorPickerOpen && (
            <div className={styles.stationColorPicker}>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={styles.stationColorChoice}
                  style={{ background: c }}
                  onClick={() => {
                    setStationColor(station.id, c);
                    setColorPickerOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.label}>所属路線（プロジェクト）</span>
          <div className={styles.lineChips}>
            {station.lineIds.map((lid) => {
              const line = lines[lid];
              if (!line) return null;
              return (
                <span
                  key={lid}
                  className={styles.lineChip}
                  style={{
                    background: `${line.color}1f`,
                    color: line.color,
                    borderColor: `${line.color}55`,
                  }}
                >
                  <span
                    className={styles.lineChipDot}
                    style={{ background: line.color }}
                  />
                  {line.name}
                  <button
                    className={styles.lineChipRemove}
                    onClick={() => onDetachLine(lid)}
                    aria-label="この路線から外す"
                    title="この路線から外す"
                  >
                    ×
                  </button>
                </span>
              );
            })}
            <span className={styles.lineHint}>
              他の路線を選んで駅をクリックすると乗換駅になります
            </span>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>関連カード</span>
          {station.cardId ? (
            linkedCard ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {linkedCard.title || '無題カード'}
                </span>
                <button className={styles.linkAdd} onClick={() => navigate('/canvas', { state: { focusCardId: linkedCard.id } })}>
                  開く
                </button>
                <button className={styles.linkRemove} onClick={unlinkCard} aria-label="リンクを解除" title="リンクを解除">×</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, color: 'var(--muted)' }}>リンク先カードが見つかりません</span>
                <button className={styles.linkRemove} onClick={unlinkCard} aria-label="リンクを解除">×</button>
              </div>
            )
          ) : (
            <>
              <input
                className={styles.input}
                placeholder="カードを検索して紐付け…"
                value={cardQuery}
                onChange={(e) => setCardQuery(e.target.value)}
              />
              {cardMatches.length > 0 && (
                <ul className={styles.linkList}>
                  {cardMatches.map((c) => (
                    <li key={c.id} className={styles.linkItem}>
                      <button
                        onClick={() => linkCard(c)}
                        style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }}
                      >
                        {c.title || (c.content ? c.content.slice(0, 24) : '無題カード')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <span className={styles.lineHint}>カードを紐付けると、駅 ↔ カードを相互に行き来できます</span>
            </>
          )}
        </div>

        <label className={styles.field}>
          <span className={styles.label}>メモ</span>
          <textarea
            className={styles.textarea}
            rows={6}
            value={station.notes}
            onChange={(e) => updateStationNotes(station.id, e.target.value)}
            placeholder="このタスクの目的・メモ・思考の整理..."
          />
        </label>

        <div className={styles.field}>
          <span className={styles.label}>リンク</span>
          {station.links.length > 0 && (
            <ul className={styles.linkList}>
              {station.links.map((link, i) => (
                <li key={i} className={styles.linkItem}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.linkAnchor}
                  >
                    {link.label}
                  </a>
                  <button
                    className={styles.linkRemove}
                    onClick={() => removeStationLink(station.id, i)}
                    aria-label="リンクを削除"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.linkForm}>
            <input
              className={styles.input}
              placeholder="ラベル（省略可）"
              value={linkLabel}
              onChange={(e) => setLinkLabel(e.target.value)}
            />
            <input
              className={styles.input}
              placeholder="https://..."
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAddLink();
                }
              }}
            />
            <button
              className={styles.linkAdd}
              onClick={onAddLink}
              disabled={!linkUrl.trim()}
            >
              追加
            </button>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.deleteBtn} onClick={onRemoveStation}>
          この駅を削除
        </button>
      </div>
    </aside>
  );
}
