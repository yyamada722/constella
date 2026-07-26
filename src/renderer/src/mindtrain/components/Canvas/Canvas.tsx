import { useRef, useState, useEffect } from 'react';
import { PALETTE, useStore } from '../../store/useStore';
import { findInsertionIndex, metroPath } from '../../utils/path';
import { snapPoint } from '../../utils/grid';
import { TrainSprite } from './TrainSprite';
import { LineLabel } from './LineLabel';
import { renderStationShape } from './shapes';
import { LABEL_DIRS, type LabelDir } from '../../types';
import { putMedia, useMediaUrl } from '../../../persistence/media';
import { IMAGE_ACCEPT, normalizeImageBlob } from '../../../utils/image';
import styles from './Canvas.module.css';

// Image annotation <image>: resolves `idb:` refs (images saved to the project
// media store) to a usable URL; base64/http srcs pass through unchanged.
function MtImage({ src, x, y, width, height }: { src: string; x: number; y: number; width: number; height: number }) {
  const url = useMediaUrl(src);
  if (!url) return null;
  return <image x={x} y={y} width={width} height={height} href={url} preserveAspectRatio="xMidYMid slice" />;
}

interface LabelLayout {
  dx: number;
  dy: number;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'auto' | 'middle' | 'hanging';
}

function getLabelLayout(
  dir: LabelDir,
  halfSize: number,
  strokeW: number
): LabelLayout {
  const corner = halfSize + strokeW / 2;
  const pad = 6;
  const diag = corner + 1;
  switch (dir) {
    case 'n':
      return { dx: 0, dy: -corner - pad, anchor: 'middle', baseline: 'auto' };
    case 'ne':
      return { dx: diag, dy: -diag, anchor: 'start', baseline: 'auto' };
    case 'e':
      return { dx: corner + pad, dy: 0, anchor: 'start', baseline: 'middle' };
    case 'se':
      return { dx: diag, dy: diag, anchor: 'start', baseline: 'hanging' };
    case 's':
      return { dx: 0, dy: corner + pad, anchor: 'middle', baseline: 'hanging' };
    case 'sw':
      return { dx: -diag, dy: diag, anchor: 'end', baseline: 'hanging' };
    case 'w':
      return { dx: -(corner + pad), dy: 0, anchor: 'end', baseline: 'middle' };
    case 'nw':
      return { dx: -diag, dy: -diag, anchor: 'end', baseline: 'auto' };
  }
}

const ARROW_GLYPH: Record<LabelDir, string> = {
  n: '↑',
  ne: '↗',
  e: '→',
  se: '↘',
  s: '↓',
  sw: '↙',
  w: '←',
  nw: '↖',
};

const PICKER_RADIUS = 34;
const DIR_OFFSET: Record<LabelDir, { x: number; y: number }> = (() => {
  const r = PICKER_RADIUS;
  const d = r * Math.SQRT1_2;
  return {
    n: { x: 0, y: -r },
    ne: { x: d, y: -d },
    e: { x: r, y: 0 },
    se: { x: d, y: d },
    s: { x: 0, y: r },
    sw: { x: -d, y: d },
    w: { x: -r, y: 0 },
    nw: { x: -d, y: -d },
  };
})();

const STATION_SIZE = 16;
const TRANSFER_SIZE = 20;
const STATION_STROKE = 4;
const TRANSFER_STROKE = 4;
const LINE_STROKE = 9;
const DRAG_THRESHOLD = 4;
const STATION_HIT_PADDING = 8;
const LINE_INSERTION_THRESHOLD = 12;
const SELECTION_COLOR = '#e84c5a';

type DragState =
  | {
      type: 'station';
      id: string;
      offX: number;
      offY: number;
      moved: boolean;
      pointerId: number;
    }
  | {
      type: 'pan';
      sx: number;
      sy: number;
      vx: number;
      vy: number;
      moved: boolean;
      pointerId: number;
    }
  | {
      type: 'marquee';
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      additive: boolean;
      moved: boolean;
      pointerId: number;
    }
  | {
      type: 'annotation';
      id: string;
      offX: number;
      offY: number;
      moved: boolean;
      pointerId: number;
    }
  | {
      type: 'area-define';
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      pointerId: number;
    }
  | {
      type: 'annotation-resize';
      id: string;
      corner: 'nw' | 'ne' | 'sw' | 'se';
      origX: number;
      origY: number;
      origW: number;
      origH: number;
      pointerId: number;
    };

export function Canvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [vp, setVp] = useState({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null
  );
  const [annColorPickerOpen, setAnnColorPickerOpen] = useState(false);

  const stations = useStore((s) => s.stations);
  const lines = useStore((s) => s.lines);
  const lineOrder = useStore((s) => s.lineOrder);
  const trains = useStore((s) => s.trains);
  const trainOrder = useStore((s) => s.trainOrder);
  const annotations = useStore((s) => s.annotations);
  const annotationOrder = useStore((s) => s.annotationOrder);
  const selectedAnnotationId = useStore((s) => s.selectedAnnotationId);
  const activeLineId = useStore((s) => s.activeLineId);
  const selectedStationId = useStore((s) => s.selectedStationId);
  const selectedStationIds = useStore((s) => s.selectedStationIds);
  const selectedAnnotationIds = useStore((s) => s.selectedAnnotationIds);
  const setSelection = useStore((s) => s.setSelection);
  const toggleStationSelection = useStore((s) => s.toggleStationSelection);
  const toggleAnnotationSelection = useStore((s) => s.toggleAnnotationSelection);
  const moveSelectedBy = useStore((s) => s.moveSelectedBy);
  const removeSelected = useStore((s) => s.removeSelected);
  const toolMode = useStore((s) => s.toolMode);
  const addStation = useStore((s) => s.addStation);
  const addStationAt = useStore((s) => s.addStationAt);
  const moveStation = useStore((s) => s.moveStation);
  const setStationLabelDir = useStore((s) => s.setStationLabelDir);
  const addArea = useStore((s) => s.addArea);
  const addLabel = useStore((s) => s.addLabel);
  const addImage = useStore((s) => s.addImage);
  const moveAnnotation = useStore((s) => s.moveAnnotation);
  const resizeAnnotation = useStore((s) => s.resizeAnnotation);
  const updateAnnotationText = useStore((s) => s.updateAnnotationText);
  const setAnnotationColor = useStore((s) => s.setAnnotationColor);
  const setAnnotationFontSize = useStore((s) => s.setAnnotationFontSize);
  const setAnnotationFontWeight = useStore((s) => s.setAnnotationFontWeight);
  const removeAnnotation = useStore((s) => s.removeAnnotation);
  const selectAnnotation = useStore((s) => s.selectAnnotation);
  const pickingTrainEndpoint = useStore((s) => s.pickingTrainEndpoint);
  const focusStationId = useStore((s) => s.focusStationId);
  const consumeStationFocus = useStore((s) => s.consumeStationFocus);

  useEffect(() => {
    setAnnColorPickerOpen(false);
  }, [selectedAnnotationId]);

  // Card → station jump: center the viewport on the requested station, then
  // consume the one-shot signal.
  useEffect(() => {
    if (!focusStationId) return;
    const st = stations[focusStationId];
    if (!st) { consumeStationFocus(); return; }
    requestAnimationFrame(() => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect && rect.width) setVp((prev) => ({ ...prev, x: rect.width / 2 - st.x * prev.zoom, y: rect.height / 2 - st.y * prev.zoom }));
      consumeStationFocus();
    });
  }, [focusStationId, stations, consumeStationFocus]);

  // クリップボードからの画像／テキスト貼り付け対応。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            processImageFile(file);
          }
          return;
        }
      }
      // テキスト貼り付けはラベルとして配置（フォールバック）
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        e.preventDefault();
        const c = placeAtViewportCenter();
        const id = addLabel(c.x, c.y, text.trim());
        selectAnnotation(id);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImage, addLabel, selectAnnotation, vp]);
  const setTrainRange = useStore((s) => s.setTrainRange);
  const cancelPickingTrainEndpoint = useStore(
    (s) => s.cancelPickingTrainEndpoint
  );
  const attachStationToLine = useStore((s) => s.attachStationToLine);
  const selectStation = useStore((s) => s.selectStation);
  const setToolMode = useStore((s) => s.setToolMode);
  const toggleAddMode = useStore((s) => s.toggleAddMode);

  // Center the world origin on first mount.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setVp((prev) =>
      prev.x === 0 && prev.y === 0 && prev.zoom === 1
        ? { x: rect.width / 2, y: rect.height / 2, zoom: 1 }
        : prev
    );
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (inField) return;
      if (e.key === 'Escape') {
        if (editingAnnotationId) {
          e.preventDefault();
          setEditingAnnotationId(null);
          return;
        }
        if (pickingTrainEndpoint) {
          e.preventDefault();
          cancelPickingTrainEndpoint();
          return;
        }
        if (toolMode === 'add' || toolMode === 'add-area') {
          e.preventDefault();
          setToolMode('select');
        }
        return;
      }
      if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggleAddMode();
        return;
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !editingAnnotationId &&
        (selectedStationIds.length > 0 || selectedAnnotationIds.length > 0)
      ) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    toolMode,
    setToolMode,
    toggleAddMode,
    pickingTrainEndpoint,
    cancelPickingTrainEndpoint,
    editingAnnotationId,
    selectedStationIds,
    selectedAnnotationIds,
    removeSelected,
  ]);

  const screenToWorld = (cx: number, cy: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = cx - rect.left;
    const sy = cy - rect.top;
    return {
      x: (sx - vp.x) / vp.zoom,
      y: (sy - vp.y) / vp.zoom,
    };
  };

  const findAnnotationAt = (worldX: number, worldY: number): string | null => {
    // 後から追加（手前）のものから順に判定。
    for (let i = annotationOrder.length - 1; i >= 0; i--) {
      const id = annotationOrder[i];
      const ann = annotations[id];
      if (!ann) continue;
      if (ann.kind === 'label') {
        // 複数行ラベルの概算ボックスでヒットチェック。
        const fontSize = ann.fontSize ?? 14;
        const lines = ann.text.split('\n');
        const longest = lines.reduce(
          (m, l) => Math.max(m, l.length),
          0
        );
        const w = (longest || 1) * fontSize * 0.6 + 12;
        const h = lines.length * fontSize * 1.3 + 6;
        if (
          worldX >= ann.x - 6 &&
          worldX <= ann.x + w &&
          worldY >= ann.y - 6 &&
          worldY <= ann.y + h
        )
          return id;
      } else {
        if (
          worldX >= ann.x &&
          worldX <= ann.x + ann.width &&
          worldY >= ann.y &&
          worldY <= ann.y + ann.height
        )
          return id;
      }
    }
    return null;
  };

  const findStationAt = (worldX: number, worldY: number): string | null => {
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const s of Object.values(stations)) {
      const baseSize = s.lineIds.length >= 2 ? TRANSFER_SIZE : STATION_SIZE;
      const reach = baseSize / 2 + STATION_HIT_PADDING;
      const dx = Math.abs(s.x - worldX);
      const dy = Math.abs(s.y - worldY);
      const d = Math.max(dx, dy);
      if (d <= reach && d < bestDist) {
        bestDist = d;
        bestId = s.id;
      }
    }
    return bestId;
  };

  // Pinch (trackpad, arrives as a ctrlKey wheel) and Cmd/Ctrl+wheel zoom at the
  // cursor; a plain wheel — including a two-finger trackpad swipe — pans the map.
  // Attached as a NON-passive native listener so preventDefault both stops the
  // page from scrolling and, importantly, blocks the horizontal two-finger swipe
  // from triggering browser back/forward navigation.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setVp((v) => {
          const newZoom = Math.min(4, Math.max(0.2, v.zoom * factor));
          const worldX = (sx - v.x) / v.zoom;
          const worldY = (sy - v.y) / v.zoom;
          return { x: sx - worldX * newZoom, y: sy - worldY * newZoom, zoom: newZoom };
        });
      } else {
        setVp((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const clearStaleDrag = () => {
    if (drag) {
      try { svgRef.current?.releasePointerCapture(drag.pointerId); } catch { /* noop */ }
      setDrag(null);
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // 中ボタンドラッグ = パン（要素の上でもどこでも）。
    if (e.button === 1) {
      e.preventDefault();
      clearStaleDrag();
      setDrag({ type: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y, moved: false, pointerId: e.pointerId });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // 残留 drag 状態を防御的にクリア（前のジェスチャでの取りこぼし対策）。
    clearStaleDrag();
    const target = e.target as Element;
    const w = screenToWorld(e.clientX, e.clientY);

    // リサイズハンドルが優先
    const handleEl = target.closest('[data-resize-corner]') as Element | null;
    if (handleEl) {
      const corner = handleEl.getAttribute('data-resize-corner') as
        | 'nw'
        | 'ne'
        | 'sw'
        | 'se';
      const annId = handleEl.getAttribute('data-annotation-id');
      if (annId && corner) {
        const ann = annotations[annId];
        if (ann && ann.kind !== 'label') {
          setDrag({
            type: 'annotation-resize',
            id: annId,
            corner,
            origX: ann.x,
            origY: ann.y,
            origW: ann.width,
            origH: ann.height,
            pointerId: e.pointerId,
          });
          svgRef.current?.setPointerCapture(e.pointerId);
          return;
        }
      }
    }

    // 配置モード: エリア定義を開始
    if (toolMode === 'add-area') {
      const snapped = e.shiftKey ? { x: w.x, y: w.y } : snapPoint(w.x, w.y);
      setDrag({
        type: 'area-define',
        startX: snapped.x,
        startY: snapped.y,
        curX: snapped.x,
        curY: snapped.y,
        pointerId: e.pointerId,
      });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    const stationEl = target.closest('[data-station-id]') as Element | null;
    let stationId = stationEl?.getAttribute('data-station-id') ?? null;
    if (!stationId) {
      stationId = findStationAt(w.x, w.y);
    }

    if (stationId) {
      const st = stations[stationId];
      if (!st) return;
      if (e.shiftKey) { toggleStationSelection(stationId); return; }
      // Replace the selection unless this station is already part of a multi-
      // selection (so a group can be dragged) or we're picking a train endpoint.
      if (!pickingTrainEndpoint && !selectedStationIds.includes(stationId)) selectStation(stationId);
      setDrag({
        type: 'station',
        id: stationId,
        offX: w.x - st.x,
        offY: w.y - st.y,
        moved: false,
        pointerId: e.pointerId,
      });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    // アノテーション判定（駅より優先度低）
    const annId = findAnnotationAt(w.x, w.y);
    if (annId) {
      const ann = annotations[annId];
      if (ann) {
        if (e.shiftKey) { toggleAnnotationSelection(annId); return; }
        if (!selectedAnnotationIds.includes(annId)) selectAnnotation(annId);
        setDrag({
          type: 'annotation',
          id: annId,
          offX: w.x - ann.x,
          offY: w.y - ann.y,
          moved: false,
          pointerId: e.pointerId,
        });
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
    }

    // 空白を左ドラッグ = マーキー選択（動かなければクリック扱い）。
    setDrag({
      type: 'marquee',
      startX: w.x,
      startY: w.y,
      curX: w.x,
      curY: w.y,
      additive: e.shiftKey,
      moved: false,
      pointerId: e.pointerId,
    });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.type === 'pan') {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      setDrag({ ...drag, moved: true });
      setVp((prev) => ({ ...prev, x: drag.vx + dx, y: drag.vy + dy }));
      return;
    }
    if (drag.type === 'marquee') {
      const w = screenToWorld(e.clientX, e.clientY);
      const moved = drag.moved || Math.hypot(w.x - drag.startX, w.y - drag.startY) * vp.zoom > DRAG_THRESHOLD;
      setDrag({ ...drag, curX: w.x, curY: w.y, moved });
      return;
    }
    if (drag.type === 'area-define') {
      const w = screenToWorld(e.clientX, e.clientY);
      const target = e.shiftKey ? { x: w.x, y: w.y } : snapPoint(w.x, w.y);
      setDrag({ ...drag, curX: target.x, curY: target.y });
      return;
    }
    if (drag.type === 'annotation-resize') {
      const w = screenToWorld(e.clientX, e.clientY);
      const target = e.shiftKey ? { x: w.x, y: w.y } : snapPoint(w.x, w.y);
      const right = drag.origX + drag.origW;
      const bottom = drag.origY + drag.origH;
      let nx = drag.origX;
      let ny = drag.origY;
      let nw = drag.origW;
      let nh = drag.origH;
      const minW = 20;
      const minH = 16;
      if (drag.corner === 'nw') {
        nx = Math.min(target.x, right - minW);
        ny = Math.min(target.y, bottom - minH);
        nw = right - nx;
        nh = bottom - ny;
      } else if (drag.corner === 'ne') {
        ny = Math.min(target.y, bottom - minH);
        nw = Math.max(minW, target.x - drag.origX);
        nh = bottom - ny;
      } else if (drag.corner === 'sw') {
        nx = Math.min(target.x, right - minW);
        nw = right - nx;
        nh = Math.max(minH, target.y - drag.origY);
      } else {
        nw = Math.max(minW, target.x - drag.origX);
        nh = Math.max(minH, target.y - drag.origY);
      }
      resizeAnnotation(drag.id, nx, ny, nw, nh);
      return;
    }
    if (drag.type === 'annotation') {
      const w = screenToWorld(e.clientX, e.clientY);
      const rawX = w.x - drag.offX;
      const rawY = w.y - drag.offY;
      const target = e.shiftKey
        ? { x: rawX, y: rawY }
        : snapPoint(rawX, rawY);
      const ann = annotations[drag.id];
      if (!ann) return;
      const dx = target.x - ann.x;
      const dy = target.y - ann.y;
      if (
        !drag.moved &&
        Math.hypot(rawX - ann.x, rawY - ann.y) <= DRAG_THRESHOLD / vp.zoom
      )
        return;
      if (dx === 0 && dy === 0) {
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
      setDrag({ ...drag, moved: true });
      // Move the whole selection by the dragged item's delta (group move).
      moveSelectedBy(dx, dy);
      return;
    }
    // station drag
    const w = screenToWorld(e.clientX, e.clientY);
    const rawX = w.x - drag.offX;
    const rawY = w.y - drag.offY;
    const target = e.shiftKey ? { x: rawX, y: rawY } : snapPoint(rawX, rawY);
    const st = stations[drag.id];
    if (!st) return;
    const dx = target.x - st.x;
    const dy = target.y - st.y;
    if (!drag.moved && Math.hypot(rawX - st.x, rawY - st.y) <= DRAG_THRESHOLD / vp.zoom) return;
    if (dx === 0 && dy === 0) {
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }
    setDrag({ ...drag, moved: true });
    // Move the whole selection by the dragged station's delta (group move).
    moveSelectedBy(dx, dy);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.type === 'pan') {
      // 中ボタンのパン。クリック（移動なし）は何もしない。
    } else if (drag.type === 'marquee') {
      const w = screenToWorld(e.clientX, e.clientY);
      if (!drag.moved) {
        // 空白クリック: 駅配置 / ピック解除 / 選択クリア
        if (pickingTrainEndpoint) {
          cancelPickingTrainEndpoint();
        } else if (toolMode === 'add' && activeLineId) {
          const target = e.shiftKey ? { x: w.x, y: w.y } : snapPoint(w.x, w.y);
          const activeLine = lines[activeLineId];
          const linePts = activeLine
            ? activeLine.stationIds.map((id) => stations[id]).filter(Boolean).map((s) => ({ x: s.x, y: s.y }))
            : [];
          const insertIdx =
            linePts.length >= 2 ? findInsertionIndex(linePts, target, LINE_INSERTION_THRESHOLD) : null;
          if (insertIdx !== null) addStationAt(target.x, target.y, activeLineId, insertIdx);
          else addStation(target.x, target.y, activeLineId);
        } else {
          setSelection([], []);
        }
      } else {
        // マーキー確定: 矩形内の駅・アノテーションを選択（Shift で追加）
        const x0 = Math.min(drag.startX, drag.curX), y0 = Math.min(drag.startY, drag.curY);
        const x1 = Math.max(drag.startX, drag.curX), y1 = Math.max(drag.startY, drag.curY);
        const inRect = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        const sIds = Object.values(stations).filter((s) => inRect(s.x, s.y)).map((s) => s.id);
        const aIds = annotationOrder.filter((id) => {
          const a = annotations[id];
          if (!a) return false;
          const cx = 'width' in a ? a.x + a.width / 2 : a.x;
          const cy = 'height' in a ? a.y + a.height / 2 : a.y;
          return inRect(cx, cy);
        });
        if (drag.additive) {
          setSelection([...new Set([...selectedStationIds, ...sIds])], [...new Set([...selectedAnnotationIds, ...aIds])]);
        } else {
          setSelection(sIds, aIds);
        }
      }
    } else if (drag.type === 'station' && !drag.moved) {
      const st = stations[drag.id];
      if (st) {
        if (pickingTrainEndpoint) {
          const train = trains[pickingTrainEndpoint.trainId];
          if (train && st.lineIds.includes(train.lineId)) {
            const newFrom =
              pickingTrainEndpoint.endpoint === 'from'
                ? st.id
                : train.fromStationId;
            const newTo =
              pickingTrainEndpoint.endpoint === 'to'
                ? st.id
                : train.toStationId;
            setTrainRange(train.id, newFrom, newTo);
            cancelPickingTrainEndpoint();
          } else {
            cancelPickingTrainEndpoint();
          }
        } else {
          if (
            toolMode === 'add' &&
            activeLineId &&
            !st.lineIds.includes(activeLineId)
          ) {
            attachStationToLine(drag.id, activeLineId);
          }
          selectStation(drag.id);
        }
      }
    } else if (drag.type === 'annotation' && !drag.moved) {
      selectAnnotation(drag.id);
    } else if (drag.type === 'area-define') {
      const x0 = Math.min(drag.startX, drag.curX);
      const y0 = Math.min(drag.startY, drag.curY);
      const w0 = Math.abs(drag.curX - drag.startX);
      const h0 = Math.abs(drag.curY - drag.startY);
      if (w0 >= 20 && h0 >= 20) {
        addArea(x0, y0, w0, h0);
      } else if (w0 < 4 && h0 < 4) {
        // ほぼクリックのみ → デフォルトサイズで配置
        addArea(drag.startX, drag.startY, 200, 120);
      }
      setToolMode('select');
    }
    svgRef.current?.releasePointerCapture(e.pointerId);
    setDrag(null);
  };

  const renderLines = () => {
    const out: React.ReactNode[] = [];
    lineOrder.forEach((lid) => {
      const line = lines[lid];
      if (!line || line.stationIds.length < 2) return;
      const stationsOnLine = line.stationIds
        .map((sid) => stations[sid])
        .filter(Boolean);
      if (stationsOnLine.length < 2) return;
      const dimmed = activeLineId !== null && activeLineId !== lid;
      const dimOpacity = dimmed ? 0.28 : 1;

      for (let i = 0; i < stationsOnLine.length - 1; i++) {
        const a = stationsOnLine[i];
        const b = stationsOnLine[i + 1];
        const planned = a.status === 'todo' || b.status === 'todo';
        const segD = metroPath([
          { x: a.x, y: a.y },
          { x: b.x, y: b.y },
        ]);
        out.push(
          <path
            key={`${lid}-seg-${i}`}
            d={segD}
            fill="none"
            stroke={line.color}
            strokeWidth={LINE_STROKE}
            strokeLinecap={planned ? 'butt' : 'round'}
            strokeLinejoin="round"
            opacity={planned ? 0.45 * dimOpacity : dimOpacity}
            strokeDasharray={planned ? '8 6' : undefined}
            pointerEvents="none"
          />
        );
      }
    });
    return out;
  };

  const renderAnnotationsBackground = () => {
    const out: React.ReactNode[] = [];
    annotationOrder.forEach((id) => {
      const ann = annotations[id];
      if (!ann) return;
      if (ann.kind === 'label') return;
      const isSelected = selectedAnnotationIds.includes(id);
      if (ann.kind === 'area') {
        out.push(
          <g key={id} data-annotation-id={id} pointerEvents="none">
            <rect
              x={ann.x}
              y={ann.y}
              width={ann.width}
              height={ann.height}
              rx={6}
              fill={ann.color}
              fillOpacity={0.12}
              stroke={ann.color}
              strokeWidth={isSelected ? 2.5 : 2}
              strokeDasharray={isSelected ? undefined : '6 4'}
            />
            {ann.text && (
              <text
                x={ann.x + 10}
                y={ann.y + 18}
                fontFamily="Inter, system-ui, sans-serif"
                fontSize={12}
                fontWeight={700}
                fill={ann.color}
                style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                {ann.text}
              </text>
            )}
            {isSelected && (
              <rect
                x={ann.x - 4}
                y={ann.y - 4}
                width={ann.width + 8}
                height={ann.height + 8}
                rx={8}
                fill="none"
                stroke="#e84c5a"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                opacity={0.8}
                pointerEvents="none"
              />
            )}
          </g>
        );
      } else if (ann.kind === 'image') {
        out.push(
          <g key={id} data-annotation-id={id} pointerEvents="none">
            <MtImage src={ann.src} x={ann.x} y={ann.y} width={ann.width} height={ann.height} />
            {isSelected && (
              <rect
                x={ann.x - 4}
                y={ann.y - 4}
                width={ann.width + 8}
                height={ann.height + 8}
                rx={6}
                fill="none"
                stroke="#e84c5a"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                opacity={0.8}
                pointerEvents="none"
              />
            )}
          </g>
        );
      }
    });
    return out;
  };

  const renderAnnotationHandles = () => {
    if (!selectedAnnotationId) return null;
    const ann = annotations[selectedAnnotationId];
    if (!ann || ann.kind === 'label') return null;
    const handle = 8 / Math.max(0.4, vp.zoom); // 画面で 8px 程度になるよう逆スケール
    const corners: {
      name: 'nw' | 'ne' | 'sw' | 'se';
      x: number;
      y: number;
      cursor: string;
    }[] = [
      { name: 'nw', x: ann.x, y: ann.y, cursor: 'nwse-resize' },
      { name: 'ne', x: ann.x + ann.width, y: ann.y, cursor: 'nesw-resize' },
      { name: 'sw', x: ann.x, y: ann.y + ann.height, cursor: 'nesw-resize' },
      {
        name: 'se',
        x: ann.x + ann.width,
        y: ann.y + ann.height,
        cursor: 'nwse-resize',
      },
    ];
    return corners.map((c) => (
      <rect
        key={c.name}
        data-annotation-id={ann.id}
        data-resize-corner={c.name}
        x={c.x - handle / 2}
        y={c.y - handle / 2}
        width={handle}
        height={handle}
        rx={1.5 / Math.max(0.4, vp.zoom)}
        fill="#ffffff"
        stroke="#1a1d22"
        strokeWidth={1.5 / Math.max(0.4, vp.zoom)}
        pointerEvents="all"
        style={{ cursor: c.cursor }}
      />
    ));
  };

  const renderAnnotationsForeground = () => {
    const out: React.ReactNode[] = [];
    annotationOrder.forEach((id) => {
      const ann = annotations[id];
      if (!ann || ann.kind !== 'label') return;
      const isSelected = selectedAnnotationIds.includes(id);
      const fontSize = ann.fontSize ?? 14;
      const color = ann.color ?? '#1a1d22';
      const fontWeight = ann.fontWeight ?? 600;
      const lines = ann.text.length > 0 ? ann.text.split('\n') : [''];
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      const lineHeight = fontSize * 1.3;
      out.push(
        <g key={id} data-annotation-id={id} pointerEvents="none">
          <text
            x={ann.x}
            y={ann.y + fontSize}
            fontFamily="Inter, system-ui, sans-serif"
            fontSize={fontSize}
            fontWeight={fontWeight}
            fill={color}
            stroke="#eceff3"
            strokeWidth={Math.max(2, fontSize * 0.2)}
            paintOrder="stroke"
            style={{ letterSpacing: '-0.005em' }}
          >
            {lines.map((line, i) => (
              <tspan key={i} x={ann.x} dy={i === 0 ? 0 : lineHeight}>
                {line || '​'}
              </tspan>
            ))}
          </text>
          {isSelected && (
            <rect
              x={ann.x - 4}
              y={ann.y - 2}
              width={Math.max(40, longest * fontSize * 0.6 + 12)}
              height={lines.length * lineHeight + 4}
              rx={4}
              fill="none"
              stroke="#e84c5a"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              opacity={0.8}
              pointerEvents="none"
            />
          )}
        </g>
      );
    });
    return out;
  };

  const renderTrainOutlines = () => {
    const out: React.ReactNode[] = [];
    // 同一路線内で複数の電車が重ならないようにスタックさせる。
    const lineTrainIndex: Record<string, number> = {};
    for (const tid of trainOrder) {
      const train = trains[tid];
      if (!train) continue;
      const line = lines[train.lineId];
      if (!line) continue;
      const fromIdx = line.stationIds.indexOf(train.fromStationId);
      const toIdx = line.stationIds.indexOf(train.toStationId);
      if (fromIdx < 0 || toIdx < 0) continue;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      if (hi - lo < 1) continue;
      const segStations = line.stationIds
        .slice(lo, hi + 1)
        .map((sid) => stations[sid])
        .filter(Boolean);
      if (segStations.length < 2) continue;
      const segD = metroPath(
        segStations.map((s) => ({ x: s.x, y: s.y }))
      );
      const indexInLine = lineTrainIndex[train.lineId] ?? 0;
      lineTrainIndex[train.lineId] = indexInLine + 1;
      const offsetY = 10 + indexInLine * 5;
      const color = train.color ?? line.color;
      const dim = activeLineId !== null && activeLineId !== train.lineId;
      out.push(
        <path
          key={`outline-${tid}`}
          d={segD}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`translate(0 ${offsetY})`}
          opacity={dim ? 0.3 : 0.9}
          pointerEvents="none"
        />
      );
    }
    return out;
  };

  const renderLineLabels = () => {
    const out: React.ReactNode[] = [];
    lineOrder.forEach((lid) => {
      const line = lines[lid];
      if (!line || line.stationIds.length === 0) return;
      const sList = line.stationIds
        .map((sid) => stations[sid])
        .filter(Boolean);
      if (sList.length === 0) return;
      const first = sList[0];
      const second = sList[1];
      // Direction outward from the first station, opposite the second.
      let dx = 0;
      let dy = -1;
      if (second) {
        const ddx = second.x - first.x;
        const ddy = second.y - first.y;
        const len = Math.hypot(ddx, ddy);
        if (len > 0) {
          dx = -ddx / len;
          dy = -ddy / len;
        }
      }
      const dim = activeLineId !== null && activeLineId !== lid;
      out.push(
        <LineLabel
          key={`linelabel-${lid}`}
          anchorX={first.x}
          anchorY={first.y}
          dirX={dx}
          dirY={dy}
          gap={STATION_SIZE / 2 + STATION_STROKE / 2 + 8}
          color={line.color}
          name={line.name}
          dim={dim}
        />
      );
    });
    return out;
  };

  const renderTrains = () => {
    const out: React.ReactNode[] = [];
    lineOrder.forEach((lid) => {
      const line = lines[lid];
      if (!line || line.stationIds.length < 2) return;
      const sList = line.stationIds
        .map((sid) => stations[sid])
        .filter(Boolean);
      if (sList.length < 2) return;

      const lineTrains = trainOrder
        .map((tid) => trains[tid])
        .filter((t) => t && t.lineId === lid);

      if (lineTrains.length === 0) {
        // ユーザー定義の電車がなければ、連続して「開業」している区間に
        // 自動の名前なし電車を走らせる（点群モード）。
        const runs: { from: number; to: number }[] = [];
        let curStart = -1;
        for (let i = 0; i < sList.length; i++) {
          if (sList[i].status === 'done') {
            if (curStart === -1) curStart = i;
          } else {
            if (curStart !== -1 && i - curStart >= 2) {
              runs.push({ from: curStart, to: i - 1 });
            }
            curStart = -1;
          }
        }
        if (curStart !== -1 && sList.length - curStart >= 2) {
          runs.push({ from: curStart, to: sList.length - 1 });
        }
        runs.forEach((run) => {
          const segStations = sList.slice(run.from, run.to + 1);
          const segD = metroPath(
            segStations.map((s) => ({ x: s.x, y: s.y }))
          );
          const duration = Math.max(3, segStations.length * 1.6);
          out.push(
            <TrainSprite
              key={`auto-${lid}-${run.from}-${run.to}`}
              pathD={segD}
              color={line.color}
              durationMs={duration * 1000}
            />
          );
        });
      } else {
        // ユーザー定義の電車：それぞれが指定した from-to 区間を走る（メッシュモード）。
        lineTrains.forEach((train, idx) => {
          const fromIdx = line.stationIds.indexOf(train.fromStationId);
          const toIdx = line.stationIds.indexOf(train.toStationId);
          if (fromIdx < 0 || toIdx < 0) return;
          const lo = Math.min(fromIdx, toIdx);
          const hi = Math.max(fromIdx, toIdx);
          if (hi - lo < 1) return;
          const segStations = line.stationIds
            .slice(lo, hi + 1)
            .map((sid) => stations[sid])
            .filter(Boolean);
          if (segStations.length < 2) return;
          const segD = metroPath(
            segStations.map((s) => ({ x: s.x, y: s.y }))
          );
          const duration = Math.max(3, segStations.length * 1.6);
          const phase =
            lineTrains.length > 1 ? idx / lineTrains.length : 0;
          out.push(
            <TrainSprite
              key={train.id}
              pathD={segD}
              color={train.color ?? line.color}
              durationMs={duration * 1000}
              phase={phase}
              name={train.name}
              shape={train.shape ?? 'capsule'}
            />
          );
        });
      }
    });
    return out;
  };

  const renderStations = () =>
    Object.values(stations).map((st) => {
      const isTransfer = st.lineIds.length >= 2;
      const primaryLine = lines[st.lineIds[0]];
      const lineColor = primaryLine?.color ?? '#888';
      const overrideColor = st.color;
      const strokeColor =
        overrideColor ?? (isTransfer ? '#1a1d22' : lineColor);
      const size = isTransfer ? TRANSFER_SIZE : STATION_SIZE;
      const strokeW = isTransfer ? TRANSFER_STROKE : STATION_STROKE;
      const half = size / 2;
      const hitSize = size + STATION_HIT_PADDING * 2;
      const hitHalf = hitSize / 2;
      const selPad = 7;
      const isSelected = selectedStationIds.includes(st.id);
      const planned = st.status === 'todo';
      const shape = st.shape ?? 'rounded-square';
      return (
        <g
          key={st.id}
          data-station-id={st.id}
          className={styles.station}
        >
          <rect
            x={st.x - hitHalf}
            y={st.y - hitHalf}
            width={hitSize}
            height={hitSize}
            fill="#ffffff"
            fillOpacity={0}
            pointerEvents="all"
          />
          {isSelected && (
            <g
              pointerEvents="none"
              opacity={0.85}
              strokeDasharray="3 3"
            >
              {renderStationShape({
                shape,
                cx: st.x,
                cy: st.y,
                size: size + selPad * 2,
                fill: 'none',
                stroke: SELECTION_COLOR,
                strokeWidth: 1.5,
              })}
            </g>
          )}
          <g
            opacity={planned ? 0.55 : 1}
            strokeDasharray={planned ? '4 3' : undefined}
          >
            {renderStationShape({
              shape,
              cx: st.x,
              cy: st.y,
              size,
              fill: '#ffffff',
              stroke: strokeColor,
              strokeWidth: strokeW,
            })}
          </g>
          {(() => {
            const layout = getLabelLayout(st.labelDir ?? 'n', half, strokeW);
            return (
              <text
                x={st.x + layout.dx}
                y={st.y + layout.dy}
                className={styles.label}
                textAnchor={layout.anchor}
                dominantBaseline={layout.baseline}
                style={{
                  fontWeight: planned ? 500 : 700,
                  opacity: planned ? 0.65 : 1,
                }}
              >
                {st.name}
              </text>
            );
          })()}
        </g>
      );
    });

  const totalLines = lineOrder.length;

  const inAddMode = toolMode === 'add' && !!activeLineId;
  const inPickingMode = !!pickingTrainEndpoint;
  const activeLine = activeLineId ? lines[activeLineId] : null;
  const pickingTrain = pickingTrainEndpoint
    ? trains[pickingTrainEndpoint.trainId]
    : null;
  const selectedStation =
    selectedStationId && stations[selectedStationId]
      ? stations[selectedStationId]
      : null;
  const selectedScreen = selectedStation
    ? {
        x: vp.x + selectedStation.x * vp.zoom,
        y: vp.y + selectedStation.y * vp.zoom,
      }
    : null;

  const placeAtViewportCenter = () => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (rect.width / 2 - vp.x) / vp.zoom,
      y: (rect.height / 2 - vp.y) / vp.zoom,
    };
  };

  // World-space bounding box of all content (stations + annotations), or null if empty.
  const contentBounds = () => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
    for (const s of Object.values(stations)) {
      has = true;
      if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
    }
    for (const a of Object.values(annotations)) {
      has = true;
      const w = 'width' in a ? a.width : 0;
      const h = 'height' in a ? a.height : 0;
      if (a.x < minX) minX = a.x; if (a.y < minY) minY = a.y;
      if (a.x + w > maxX) maxX = a.x + w; if (a.y + h > maxY) maxY = a.y + h;
    }
    return has ? { minX, minY, maxX, maxY } : null;
  };

  // Fit everything into view (centered) — recovers from a lost/zoomed-out viewport.
  const fitToContent = () => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const b = contentBounds();
    if (!b) { setVp({ x: rect.width / 2, y: rect.height / 2, zoom: 1 }); return; }
    const pad = 60;
    const w = (b.maxX - b.minX) + pad * 2, h = (b.maxY - b.minY) + pad * 2;
    const zoom = Math.min(4, Math.max(0.2, Math.min(rect.width / Math.max(1, w), rect.height / Math.max(1, h))));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    setVp({ x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom, zoom });
  };

  const processImageFile = async (file: File, atWorld?: { x: number; y: number }) => {
    const srcBlob = await normalizeImageBlob(file); // TIFF/TGA → PNG so <img> can load it
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = async () => {
        // 表示サイズはキャンバス上で最大 480 ぐらいに収まる程度。
        // ソースのピクセル数は Retina 想定で表示サイズの ~2 倍まで保持。
        const maxDisplay = 480;
        const maxSource = 1280;
        const longest = Math.max(img.width, img.height || 1);
        // ストアに格納する実ピクセルサイズ
        const sourceScale = Math.min(1, maxSource / longest);
        const sw = Math.max(1, Math.round(img.width * sourceScale));
        const sh = Math.max(1, Math.round(img.height * sourceScale));
        // キャンバス上の表示サイズ（world 座標）
        const displayScale = Math.min(1, maxDisplay / longest);
        const dw = Math.max(20, Math.round(img.width * displayScale));
        const dh = Math.max(20, Math.round(img.height * displayScale));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, sw, sh);
        const isPng = srcBlob.type === 'image/png';
        const center = atWorld ?? placeAtViewportCenter();
        try {
          // Save the (compressed) image into the project media store (IndexedDB)
          // and reference it by an idb: URL, instead of inlining base64 into the
          // workspace JSON — keeps the DB small and rides along in backups.
          const blob = await new Promise<Blob | null>((res) =>
            canvas.toBlob(res, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.9)
          );
          const ref = blob
            ? await putMedia(blob)
            : (isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9));
          addImage(center.x - dw / 2, center.y - dh / 2, ref, dw, dh);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[mindtrain] addImage failed', err);
          window.alert('画像の保存に失敗しました。サイズが大きすぎる可能性があります。');
        }
      };
      img.onerror = () => {
        window.alert('画像の読み込みに失敗しました');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const onPickImage: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    processImageFile(file);
  };

  const onDoubleClickSvg = (e: React.MouseEvent<SVGSVGElement>) => {
    const w = screenToWorld(e.clientX, e.clientY);
    const annId = findAnnotationAt(w.x, w.y);
    if (annId) {
      const ann = annotations[annId];
      if (ann && ann.kind !== 'image') {
        setEditingAnnotationId(annId);
        selectAnnotation(annId);
      }
    }
  };

  const inAreaMode = toolMode === 'add-area';
  const editingAnnotation = editingAnnotationId
    ? annotations[editingAnnotationId]
    : null;
  const selectedAnnotation =
    selectedAnnotationId && annotations[selectedAnnotationId]
      ? annotations[selectedAnnotationId]
      : null;

  return (
    <div
      className={`${styles.container} ${inAddMode ? styles.addMode : ''} ${
        inPickingMode ? styles.pickingMode : ''
      } ${inAreaMode ? styles.areaMode : ''}`}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        onDoubleClick={onDoubleClickSvg}
        onPointerDown={onPointerDown}
        onPointerCancel={(e) => {
          if (drag && drag.pointerId === e.pointerId) {
            try {
              svgRef.current?.releasePointerCapture(e.pointerId);
            } catch {
              // noop
            }
            setDrag(null);
          }
        }}
        onLostPointerCapture={(e) => {
          if (drag && drag.pointerId === e.pointerId) {
            setDrag(null);
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <defs>
          <pattern
            id="grid"
            width={40}
            height={40}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${vp.x % (40 * vp.zoom)} ${vp.y % (40 * vp.zoom)}) scale(${vp.zoom})`}
          >
            <circle cx={20} cy={20} r={1} fill="#c2c7cf" opacity={0.7} />
          </pattern>
        </defs>
        <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${vp.x} ${vp.y}) scale(${vp.zoom})`}>
          <g>{renderAnnotationsBackground()}</g>
          <g>{renderTrainOutlines()}</g>
          <g>{renderLines()}</g>
          <g>{renderTrains()}</g>
          <g>{renderLineLabels()}</g>
          <g>{renderAnnotationsForeground()}</g>
          <g>{renderStations()}</g>
          <g>{renderAnnotationHandles()}</g>
          {drag?.type === 'area-define' &&
            (() => {
              const x0 = Math.min(drag.startX, drag.curX);
              const y0 = Math.min(drag.startY, drag.curY);
              const w0 = Math.abs(drag.curX - drag.startX);
              const h0 = Math.abs(drag.curY - drag.startY);
              return (
                <rect
                  x={x0}
                  y={y0}
                  width={w0}
                  height={h0}
                  rx={6}
                  fill="#e84c5a"
                  fillOpacity={0.1}
                  stroke="#e84c5a"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  pointerEvents="none"
                />
              );
            })()}
          {drag?.type === 'marquee' && drag.moved &&
            (() => {
              const x0 = Math.min(drag.startX, drag.curX);
              const y0 = Math.min(drag.startY, drag.curY);
              return (
                <rect
                  x={x0}
                  y={y0}
                  width={Math.abs(drag.curX - drag.startX)}
                  height={Math.abs(drag.curY - drag.startY)}
                  fill="rgba(45,114,217,0.10)"
                  stroke="var(--accent)"
                  strokeWidth={1 / vp.zoom}
                  strokeDasharray={`${4 / vp.zoom} ${3 / vp.zoom}`}
                  pointerEvents="none"
                />
              );
            })()}
        </g>
      </svg>

      <div className={styles.annTools}>
        <button
          className={`${styles.annTool} ${
            inAreaMode ? styles.annToolActive : ''
          }`}
          onClick={() =>
            setToolMode(inAreaMode ? 'select' : 'add-area')
          }
          title="エリア（ドラッグで矩形を描く / Esc 解除）"
          aria-label="エリアを追加"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="2 2"
            />
          </svg>
        </button>
        <button
          className={styles.annTool}
          onClick={() => {
            const c = placeAtViewportCenter();
            const id = addLabel(c.x, c.y);
            setEditingAnnotationId(id);
          }}
          title="テキストラベル"
          aria-label="ラベルを追加"
        >
          <span className={styles.annToolLetter}>T</span>
        </button>
        <button
          className={styles.annTool}
          onClick={() => fileInputRef.current?.click()}
          title="画像をアップロード"
          aria-label="画像を追加"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
            <path
              d="M3 12 L6 9 L9 12 L11 10 L13 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          style={{ display: 'none' }}
          onChange={onPickImage}
        />
      </div>

      {selectedAnnotation && !editingAnnotation && (() => {
        const ann = selectedAnnotation;
        const annHeight =
          ann.kind === 'label'
            ? (() => {
                const fs = ann.fontSize ?? 14;
                const lines = ann.text.split('\n').length || 1;
                return lines * fs * 1.3;
              })()
            : 'height' in ann
              ? ann.height
              : 24;
        const left = vp.x + ann.x * vp.zoom;
        const top = vp.y + (ann.y + annHeight) * vp.zoom + 8;
        const sizes: { label: string; px: number }[] = [
          { label: 'S', px: 12 },
          { label: 'M', px: 14 },
          { label: 'L', px: 18 },
          { label: 'XL', px: 26 },
        ];
        const currentSize = ann.kind === 'label' ? (ann.fontSize ?? 14) : 0;
        const currentBold =
          ann.kind === 'label' ? (ann.fontWeight ?? 600) >= 700 : false;
        const currentColor =
          ann.kind === 'image'
            ? null
            : ann.kind === 'label'
              ? (ann.color ?? '#1a1d22')
              : ann.color;
        return (
          <div
            className={styles.annStylePicker}
            style={{ left, top }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {ann.kind === 'label' && (
              <div className={styles.annStyleGroup}>
                {sizes.map((s) => (
                  <button
                    key={s.label}
                    className={`${styles.annStyleBtn} ${
                      currentSize === s.px ? styles.annStyleBtnActive : ''
                    }`}
                    onClick={() => setAnnotationFontSize(ann.id, s.px)}
                    title={`${s.label} (${s.px}px)`}
                  >
                    {s.label}
                  </button>
                ))}
                <button
                  className={`${styles.annStyleBtn} ${
                    currentBold ? styles.annStyleBtnActive : ''
                  }`}
                  onClick={() =>
                    setAnnotationFontWeight(ann.id, currentBold ? 500 : 800)
                  }
                  title="太字"
                >
                  <span style={{ fontWeight: 800 }}>B</span>
                </button>
              </div>
            )}
            {ann.kind !== 'image' && (
              <div className={styles.annStyleColorWrap}>
                <button
                  className={styles.annStyleColorBtn}
                  style={{ background: currentColor ?? '#1a1d22' }}
                  onClick={() => setAnnColorPickerOpen((v) => !v)}
                  title="色を変更"
                />
                {annColorPickerOpen && (
                  <div className={styles.annStyleColorPicker}>
                    {ann.kind === 'label' && (
                      <button
                        className={`${styles.annStyleColorChoice} ${styles.annStyleColorChoiceReset}`}
                        onClick={() => {
                          setAnnotationColor(ann.id, '#1a1d22');
                          setAnnColorPickerOpen(false);
                        }}
                        title="既定色"
                      >
                        ↺
                      </button>
                    )}
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        className={styles.annStyleColorChoice}
                        style={{ background: c }}
                        onClick={() => {
                          setAnnotationColor(ann.id, c);
                          setAnnColorPickerOpen(false);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              className={styles.annStyleBtn}
              onClick={() => {
                setEditingAnnotationId(ann.id);
                setAnnColorPickerOpen(false);
              }}
              title="編集"
              aria-label="編集"
            >
              ✎
            </button>
            <button
              className={`${styles.annStyleBtn} ${styles.annStyleBtnDanger}`}
              onClick={() => removeAnnotation(ann.id)}
              title="削除"
              aria-label="削除"
            >
              ×
            </button>
          </div>
        );
      })()}

      {editingAnnotation && editingAnnotation.kind !== 'image' && (
        <textarea
          className={styles.annEditInput}
          autoFocus
          defaultValue={editingAnnotation.text}
          rows={
            editingAnnotation.kind === 'label'
              ? Math.max(1, editingAnnotation.text.split('\n').length)
              : 1
          }
          style={{
            left: vp.x + editingAnnotation.x * vp.zoom,
            top: vp.y + editingAnnotation.y * vp.zoom,
            fontSize:
              editingAnnotation.kind === 'label'
                ? (editingAnnotation.fontSize ?? 14) * vp.zoom
                : 14,
            color:
              editingAnnotation.kind === 'label'
                ? (editingAnnotation.color ?? '#1a1d22')
                : '#1a1d22',
            fontWeight:
              editingAnnotation.kind === 'label'
                ? (editingAnnotation.fontWeight ?? 600)
                : 600,
          }}
          onFocus={(e) =>
            e.target.setSelectionRange(
              e.target.value.length,
              e.target.value.length
            )
          }
          onBlur={(e) => {
            updateAnnotationText(editingAnnotation.id, e.target.value);
            setEditingAnnotationId(null);
          }}
          onKeyDown={(e) => {
            const ne = e.nativeEvent as KeyboardEvent & {
              isComposing?: boolean;
            };
            if (
              e.key === 'Enter' &&
              !ne.isComposing &&
              !e.shiftKey &&
              editingAnnotation.kind !== 'label'
            ) {
              e.preventDefault();
              updateAnnotationText(
                editingAnnotation.id,
                (e.target as HTMLTextAreaElement).value
              );
              setEditingAnnotationId(null);
            } else if (
              (e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                !ne.isComposing) ||
              e.key === 'Escape'
            ) {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditingAnnotationId(null);
              } else {
                e.preventDefault();
                updateAnnotationText(
                  editingAnnotation.id,
                  (e.target as HTMLTextAreaElement).value
                );
                setEditingAnnotationId(null);
              }
            }
          }}
        />
      )}

      {inPickingMode && pickingTrain && (
        <div className={styles.pickingHint}>
          <span
            className={styles.pickingDot}
            style={{
              background:
                lines[pickingTrain.lineId]?.color ?? 'var(--ink)',
            }}
          />
          <strong>{pickingTrain.name}</strong>
          <span className={styles.pickingHintText}>
            の <b>{pickingTrainEndpoint!.endpoint === 'from' ? '始点' : '終点'}</b>
            駅をキャンバスでクリック
          </span>
          <button
            className={styles.pickingCancel}
            onClick={() => cancelPickingTrainEndpoint()}
          >
            キャンセル (Esc)
          </button>
        </div>
      )}
      {selectedStation && selectedScreen && !inAddMode && !inPickingMode && (
        <div
          className={styles.labelPicker}
          style={{ left: selectedScreen.x, top: selectedScreen.y }}
        >
          {LABEL_DIRS.map((dir) => {
            const off = DIR_OFFSET[dir];
            const isActive = (selectedStation.labelDir ?? 'n') === dir;
            return (
              <button
                key={dir}
                className={`${styles.dirBtn} ${
                  isActive ? styles.dirBtnActive : ''
                }`}
                style={{
                  transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setStationLabelDir(selectedStation.id, dir);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={`ラベル位置: ${dir.toUpperCase()}`}
              >
                {ARROW_GLYPH[dir]}
              </button>
            );
          })}
        </div>
      )}
      {totalLines === 0 && (
        <div className={styles.hint}>
          <strong>左パネルから路線（プロジェクト）を追加してください</strong>
          <span>路線を選んだら下部の「＋ 駅を配置」で駅（タスク）を置けます</span>
        </div>
      )}
      {totalLines > 0 && (
        <div className={styles.statusBar}>
          {activeLine ? (
            <>
              <span
                className={styles.activeColor}
                style={{ background: activeLine.color }}
              />
              <span className={styles.activeName}>{activeLine.name}</span>
              <button
                className={`${styles.toolBtn} ${
                  inAddMode ? styles.toolBtnActive : ''
                }`}
                onClick={() => toggleAddMode()}
                title="ショートカット: A / Esc で終了"
              >
                {inAddMode ? '✓ 配置中（クリックで駅追加）' : '＋ 駅を配置'}
              </button>
              <span className={styles.activeHint}>
                {inAddMode
                  ? '空白で駅追加 / 既存駅クリックで乗換 / Esc で終了'
                  : '駅クリック選択・ドラッグ移動 / 空白ドラッグで範囲選択 / Shift+クリックで複数選択 / 中ボタンでパン'}
              </span>
            </>
          ) : (
            <span className={styles.activeHint}>
              路線を選択するか、駅をクリックして編集
            </span>
          )}
        </div>
      )}

      {(Object.keys(stations).length > 0 || annotationOrder.length > 0) && (
        <div style={{ position: 'absolute', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, pointerEvents: 'none' }}>
          <button
            onClick={fitToContent}
            title="全体表示（すべてが見えるように調整）"
            style={{ pointerEvents: 'auto', padding: '5px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface, #fff)', color: 'var(--ink-soft)', fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-card)' }}
          >
            ⤢ 全体表示
          </button>
          {(() => {
            const el = svgRef.current;
            const rb = el?.getBoundingClientRect();
            const rect = rb ? { width: rb.width, height: rb.height } : { width: 800, height: 600 };
            const cb = contentBounds();
            const vMinX = (0 - vp.x) / vp.zoom, vMinY = (0 - vp.y) / vp.zoom;
            const vMaxX = (rect.width - vp.x) / vp.zoom, vMaxY = (rect.height - vp.y) / vp.zoom;
            let minX = vMinX, minY = vMinY, maxX = vMaxX, maxY = vMaxY;
            if (cb) { minX = Math.min(minX, cb.minX); minY = Math.min(minY, cb.minY); maxX = Math.max(maxX, cb.maxX); maxY = Math.max(maxY, cb.maxY); }
            const padX = (maxX - minX) * 0.06 + 24, padY = (maxY - minY) * 0.06 + 24;
            minX -= padX; minY -= padY; maxX += padX; maxY += padY;
            const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
            const MM_W = 184, MM_H = 124;
            const scale = Math.min(MM_W / bw, MM_H / bh);
            const ox = (MM_W - bw * scale) / 2, oy = (MM_H - bh * scale) / 2;
            const wx = (x: number) => (x - minX) * scale + ox;
            const wy = (y: number) => (y - minY) * scale + oy;
            return (
              <svg
                width={MM_W}
                height={MM_H}
                onPointerDown={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const worldX = (e.clientX - r.left - ox) / scale + minX;
                  const worldY = (e.clientY - r.top - oy) / scale + minY;
                  setVp((prev) => ({ ...prev, x: rect.width / 2 - worldX * prev.zoom, y: rect.height / 2 - worldY * prev.zoom }));
                }}
                style={{ pointerEvents: 'auto', background: 'rgba(255,255,255,0.92)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-card)', cursor: 'pointer' }}
              >
                {lineOrder.map((lid) => {
                  const line = lines[lid];
                  if (!line) return null;
                  const pts = line.stationIds.map((sid) => stations[sid]).filter(Boolean);
                  if (pts.length < 2) return null;
                  return <polyline key={lid} points={pts.map((s) => `${wx(s.x)},${wy(s.y)}`).join(' ')} fill="none" stroke={line.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.7} />;
                })}
                {Object.values(stations).map((s) => (
                  <circle key={s.id} cx={wx(s.x)} cy={wy(s.y)} r={1.6} fill={lines[s.lineIds[0]]?.color ?? '#888'} />
                ))}
                <rect x={wx(vMinX)} y={wy(vMinY)} width={(vMaxX - vMinX) * scale} height={(vMaxY - vMinY) * scale} fill="rgba(45,114,217,0.08)" stroke="var(--accent)" strokeWidth={1.2} rx={2} />
              </svg>
            );
          })()}
        </div>
      )}
    </div>
  );
}
