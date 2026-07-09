import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { mtConfirm } from '../../confirm';
import styles from './WorkspaceSwitcher.module.css';

// Switches between the route-map "plans" of the CURRENT Constella master project.
// Plans live under a project (workspaceMeta.projectId === activeProjectId).
export function WorkspaceSwitcher() {
  const workspaceMeta = useStore((s) => s.workspaceMeta);
  const workspaceOrder = useStore((s) => s.workspaceOrder);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const switchPlan = useStore((s) => s.switchPlan);
  const addPlan = useStore((s) => s.addPlan);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const removePlan = useStore((s) => s.removePlan);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const plans = workspaceOrder.filter((id) => workspaceMeta[id]?.projectId === activeProjectId);
  const active = workspaceMeta[activeWorkspaceId];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!active) return null;

  const onConfirmRemove = async (id: string, name: string) => {
    if (plans.length <= 1) return;
    if (
      await mtConfirm(
        `プラン「${name}」を削除しますか？\n中の路線・駅・電車もすべて削除されます。`,
        '削除'
      )
    ) {
      removePlan(id);
    }
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="プランを切り替え"
      >
        <span className={styles.label}>{active.name}</span>
        <span className={styles.chevron} data-open={open ? 'true' : 'false'}>
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.menu} role="listbox">
          <div className={styles.list}>
            {plans.map((id) => {
              const meta = workspaceMeta[id];
              if (!meta) return null;
              const isActive = id === activeWorkspaceId;
              const isEditing = editingId === id;
              return (
                <div
                  key={id}
                  className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                >
                  <button
                    className={styles.itemMain}
                    onClick={() => {
                      if (isEditing) return;
                      switchPlan(id);
                      setOpen(false);
                    }}
                    disabled={isEditing}
                  >
                    <span
                      className={styles.itemDot}
                      data-active={isActive ? 'true' : 'false'}
                    />
                    {isEditing ? (
                      <input
                        className={styles.itemInput}
                        defaultValue={meta.name}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v) renameWorkspace(id, v);
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const v = (e.target as HTMLInputElement).value.trim();
                            if (v) renameWorkspace(id, v);
                            setEditingId(null);
                          } else if (e.key === 'Escape') {
                            setEditingId(null);
                          }
                        }}
                      />
                    ) : (
                      <span className={styles.itemName}>{meta.name}</span>
                    )}
                  </button>
                  <button
                    className={styles.itemAction}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(id);
                    }}
                    title="リネーム"
                    aria-label="リネーム"
                  >
                    ✎
                  </button>
                  <button
                    className={`${styles.itemAction} ${styles.itemActionDanger}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onConfirmRemove(id, meta.name);
                    }}
                    disabled={plans.length <= 1}
                    title={
                      plans.length <= 1
                        ? '最後のプランは削除できません'
                        : '削除'
                    }
                    aria-label="削除"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className={styles.menuFooter}>
            <button
              className={styles.addBtn}
              onClick={() => {
                addPlan();
                setOpen(false);
              }}
            >
              ＋ 新規プラン
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
