import { useEffect, useState, type CSSProperties } from 'react';
import { Canvas } from './components/Canvas/Canvas';
import { LineList } from './components/LineList/LineList';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { LinePanel } from './components/LinePanel/LinePanel';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import { useStore } from './store/useStore';
import styles from './App.module.css';

const histBtn = (enabled: boolean): CSSProperties => ({
  width: 30,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: enabled ? 'var(--surface, #fff)' : 'var(--paper-soft)',
  color: enabled ? 'var(--ink-soft)' : 'var(--muted-soft)',
  cursor: enabled ? 'pointer' : 'default',
  fontSize: 15,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export default function App() {
  const selectedStationId = useStore((s) => s.selectedStationId);
  const stations = useStore((s) => s.stations);
  const showStation = !!(selectedStationId && stations[selectedStationId]);

  // Undo/redo (zundo temporal store) — reactive enabled state.
  const [hist, setHist] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const t = useStore.temporal;
    const update = () => {
      const s = t.getState();
      setHist({ canUndo: s.pastStates.length > 0, canRedo: s.futureStates.length > 0 });
    };
    update();
    return t.subscribe(update);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); useStore.temporal.getState().undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); useStore.temporal.getState().redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <span className={styles.brand}>
          <span className={styles.brandMark} />
          路線図
        </span>
        <span className={styles.topbarDivider} />
        {/* Plan switcher — multiple route maps under the active master project. */}
        <WorkspaceSwitcher />
        <span style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
          <button
            style={histBtn(hist.canUndo)}
            disabled={!hist.canUndo}
            onClick={() => useStore.temporal.getState().undo()}
            title="元に戻す (Ctrl+Z)"
            aria-label="元に戻す"
          >
            ↶
          </button>
          <button
            style={histBtn(hist.canRedo)}
            disabled={!hist.canRedo}
            onClick={() => useStore.temporal.getState().redo()}
            title="やり直す (Ctrl+Shift+Z)"
            aria-label="やり直す"
          >
            ↷
          </button>
        </span>
        <span className={styles.tagline}>
          作っているツール・プロジェクトを路線図のように整理する
        </span>
      </header>
      <main className={styles.layout}>
        <LineList />
        <Canvas />
        {showStation ? <DetailPanel /> : <LinePanel />}
      </main>
    </div>
  );
}
