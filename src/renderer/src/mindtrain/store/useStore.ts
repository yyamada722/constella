import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { temporal } from 'zundo';
import { nanoid } from 'nanoid';
import { constellaMindtrainStorage } from '../persist';
import type {
  Annotation,
  AreaAnnotation,
  ImageAnnotation,
  LabelAnnotation,
  LabelDir,
  Line,
  Station,
  StationShape,
  StationStatus,
  Train,
  TrainShape,
} from '../types';

export const PALETTE = [
  '#E84C5A',
  '#F2553A',
  '#F08C2D',
  '#F4BE2B',
  '#C0CC2B',
  '#3DAB55',
  '#1F8F4D',
  '#1AAFA0',
  '#3DC0D8',
  '#3F88E0',
  '#1F62B0',
  '#5C5BD6',
  '#9A6BC2',
  '#B43D9C',
  '#D63B7E',
  '#E8628E',
  '#C76A48',
  '#7A5C3D',
  '#5C6577',
  '#252A30',
];

export type ToolMode = 'select' | 'add' | 'add-area';

export interface PickingTrainEndpoint {
  trainId: string;
  endpoint: 'from' | 'to';
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  projectId: string; // owning Constella master project — a plan lives under a project
}

export interface WorkspaceSnapshot {
  stations: Record<string, Station>;
  lines: Record<string, Line>;
  lineOrder: string[];
  trains: Record<string, Train>;
  trainOrder: string[];
  annotations: Record<string, Annotation>;
  annotationOrder: string[];
  activeLineId: string | null;
  selectedStationId: string | null;
  selectedAnnotationId: string | null;
}

const emptyWorkspaceSnapshot = (): WorkspaceSnapshot => ({
  stations: {},
  lines: {},
  lineOrder: [],
  trains: {},
  trainOrder: [],
  annotations: {},
  annotationOrder: [],
  activeLineId: null,
  selectedStationId: null,
  selectedAnnotationId: null,
});

// Capture the current flat working state as a plan snapshot, and the inverse:
// load a snapshot back into the flat fields.
const snapshotOf = (s: State): WorkspaceSnapshot => ({
  stations: s.stations,
  lines: s.lines,
  lineOrder: s.lineOrder,
  trains: s.trains,
  trainOrder: s.trainOrder,
  annotations: s.annotations,
  annotationOrder: s.annotationOrder,
  activeLineId: s.activeLineId,
  selectedStationId: s.selectedStationId,
  selectedAnnotationId: s.selectedAnnotationId,
});
const flatFromSnapshot = (ws: WorkspaceSnapshot) => ({
  stations: ws.stations,
  lines: ws.lines,
  lineOrder: ws.lineOrder,
  trains: ws.trains,
  trainOrder: ws.trainOrder,
  annotations: ws.annotations ?? {},
  annotationOrder: ws.annotationOrder ?? [],
  activeLineId: ws.activeLineId,
  selectedStationId: ws.selectedStationId,
  selectedAnnotationId: ws.selectedAnnotationId ?? null,
});

interface State {
  // 現在のワークスペースの「アクティブなビュー」（フラットステート）
  stations: Record<string, Station>;
  lines: Record<string, Line>;
  lineOrder: string[];
  trains: Record<string, Train>;
  trainOrder: string[];
  annotations: Record<string, Annotation>;
  annotationOrder: string[];
  activeLineId: string | null;
  selectedStationId: string | null;
  selectedAnnotationId: string | null;
  // Multi-selection (marquee / Shift-click). The single *Id fields above are the
  // derived "exactly one" selection used by the detail panels.
  selectedStationIds: string[];
  selectedAnnotationIds: string[];
  // ワークスペース管理（= プロジェクト配下の「プラン」。workspaceMeta.projectId で所属を表す）
  workspaces: Record<string, WorkspaceSnapshot>;
  workspaceMeta: Record<string, WorkspaceMeta>;
  workspaceOrder: string[];
  activeWorkspaceId: string;
  // The Constella master project the route map is currently scoped to (set by the
  // host bridge), and the last-active plan per project (so switching back restores it).
  activeProjectId: string;
  activePlanByProject: Record<string, string>;
  // 共有 UI
  toolMode: ToolMode;
  pickingTrainEndpoint: PickingTrainEndpoint | null;
  // Constella から「この駅へ移動」されたときの一時シグナル（Canvas が消費して中央寄せ）
  focusStationId: string | null;
}

interface Actions {
  addLine: (name?: string, color?: string) => string;
  removeLine: (id: string) => void;
  renameLine: (id: string, name: string) => void;
  recolorLine: (id: string, color: string) => void;
  setActiveLine: (id: string | null) => void;

  addStation: (x: number, y: number, lineId: string) => string;
  addStationAt: (
    x: number,
    y: number,
    lineId: string,
    insertIndex: number
  ) => string;
  attachStationToLine: (stationId: string, lineId: string) => void;
  detachStationFromLine: (stationId: string, lineId: string) => void;
  moveStation: (id: string, x: number, y: number) => void;
  renameStation: (id: string, name: string) => void;
  updateStationNotes: (id: string, notes: string) => void;
  setStationStatus: (id: string, status: StationStatus) => void;
  setStationLabelDir: (id: string, dir: LabelDir) => void;
  setStationShape: (id: string, shape: StationShape) => void;
  setStationColor: (id: string, color: string | null) => void;
  setStationCard: (id: string, cardId: string | null) => void;
  requestStationFocus: (id: string) => void;
  consumeStationFocus: () => void;
  addStationLink: (id: string, url: string, label: string) => void;
  removeStationLink: (id: string, index: number) => void;
  removeStation: (id: string) => void;
  selectStation: (id: string | null) => void;
  // Multi-selection
  setSelection: (stationIds: string[], annotationIds: string[]) => void;
  toggleStationSelection: (id: string) => void;
  toggleAnnotationSelection: (id: string) => void;
  moveSelectedBy: (dx: number, dy: number) => void;
  removeSelected: () => void;

  setToolMode: (mode: ToolMode) => void;
  toggleAddMode: () => void;

  addTrain: (lineId: string, name?: string) => string | null;
  renameTrain: (id: string, name: string) => void;
  updateTrainNotes: (id: string, notes: string) => void;
  setTrainRange: (id: string, fromStationId: string, toStationId: string) => void;
  setTrainColor: (id: string, color: string | null) => void;
  setTrainShape: (id: string, shape: TrainShape) => void;
  removeTrain: (id: string) => void;
  startPickingTrainEndpoint: (trainId: string, endpoint: 'from' | 'to') => void;
  cancelPickingTrainEndpoint: () => void;

  addArea: (
    x: number,
    y: number,
    width: number,
    height: number,
    text?: string,
    color?: string
  ) => string;
  addLabel: (x: number, y: number, text?: string) => string;
  addImage: (
    x: number,
    y: number,
    src: string,
    width: number,
    height: number
  ) => string;
  moveAnnotation: (id: string, x: number, y: number) => void;
  resizeAnnotation: (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number
  ) => void;
  updateAnnotationText: (id: string, text: string) => void;
  setAnnotationColor: (id: string, color: string) => void;
  setAnnotationFontSize: (id: string, fontSize: number) => void;
  setAnnotationFontWeight: (id: string, weight: number) => void;
  removeAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;

  renameWorkspace: (id: string, name: string) => void;

  // Constella master-project binding: switch to the active project's current plan
  // (creating a first plan if the project has none). Plans live UNDER a project.
  bindWorkspaceToProject: (projectId: string, name?: string) => void;
  addPlan: (name?: string) => string | null;
  switchPlan: (id: string) => void;
  removePlan: (id: string) => void;
  dropProjectPlans: (projectId: string) => void;

  resetAll: () => void;
}

type Store = State & Actions;

const pickNextColor = (lines: Record<string, Line>): string => {
  const used = new Set(Object.values(lines).map((l) => l.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[Object.keys(lines).length % PALETTE.length];
};

// Selection state in one place: the multi arrays plus the derived "exactly one"
// single ids (null unless exactly one item of one kind is selected).
const selFields = (stationIds: string[], annotationIds: string[]) => ({
  selectedStationIds: stationIds,
  selectedAnnotationIds: annotationIds,
  selectedStationId: annotationIds.length === 0 && stationIds.length === 1 ? stationIds[0] : null,
  selectedAnnotationId: stationIds.length === 0 && annotationIds.length === 1 ? annotationIds[0] : null,
});

export const useStore = create<Store>()(
  persist(
    temporal(
    (set, get) => {
      // Match the Constella default master project id so a fresh install's route
      // map binds to 'master-default' with no orphaned random-id workspace.
      const defaultWsId = 'master-default';
      const defaultWs: WorkspaceMeta = {
        id: defaultWsId,
        name: 'プラン 1',
        projectId: 'master-default',
      };
      return {
      stations: {},
      lines: {},
      lineOrder: [],
      trains: {},
      trainOrder: [],
      annotations: {},
      annotationOrder: [],
      activeLineId: null,
      selectedStationId: null,
      selectedAnnotationId: null,
      selectedStationIds: [],
      selectedAnnotationIds: [],
      workspaces: { [defaultWsId]: emptyWorkspaceSnapshot() },
      workspaceMeta: { [defaultWsId]: defaultWs },
      workspaceOrder: [defaultWsId],
      activeWorkspaceId: defaultWsId,
      activeProjectId: 'master-default',
      activePlanByProject: { 'master-default': defaultWsId },
      toolMode: 'select',
      pickingTrainEndpoint: null,
      focusStationId: null,

      addLine: (name, color) => {
        const id = nanoid(8);
        set((s) => {
          const finalColor = color ?? pickNextColor(s.lines);
          const finalName = name ?? `路線 ${s.lineOrder.length + 1}`;
          return {
            lines: {
              ...s.lines,
              [id]: { id, name: finalName, color: finalColor, stationIds: [] },
            },
            lineOrder: [...s.lineOrder, id],
            activeLineId: id,
          };
        });
        return id;
      },

      removeLine: (id) =>
        set((s) => {
          const { [id]: removed, ...rest } = s.lines;
          if (!removed) return s;
          const stations: Record<string, Station> = {};
          for (const st of Object.values(s.stations)) {
            const newLineIds = st.lineIds.filter((lid) => lid !== id);
            if (newLineIds.length === 0) continue;
            stations[st.id] = { ...st, lineIds: newLineIds };
          }
          const wasActive = s.activeLineId === id;
          const trains: Record<string, Train> = {};
          for (const t of Object.values(s.trains)) {
            if (t.lineId !== id) trains[t.id] = t;
          }
          return {
            lines: rest,
            lineOrder: s.lineOrder.filter((lid) => lid !== id),
            stations,
            trains,
            trainOrder: s.trainOrder.filter((tid) => trains[tid]),
            activeLineId: wasActive ? null : s.activeLineId,
            toolMode: wasActive ? 'select' : s.toolMode,
            selectedStationId:
              s.selectedStationId && !stations[s.selectedStationId]
                ? null
                : s.selectedStationId,
          };
        }),

      renameLine: (id, name) =>
        set((s) =>
          s.lines[id]
            ? { lines: { ...s.lines, [id]: { ...s.lines[id], name } } }
            : s
        ),

      recolorLine: (id, color) =>
        set((s) =>
          s.lines[id]
            ? { lines: { ...s.lines, [id]: { ...s.lines[id], color } } }
            : s
        ),

      setActiveLine: (id) =>
        set((s) => ({
          activeLineId: id,
          toolMode: id === null ? 'select' : s.toolMode,
        })),

      addStation: (x, y, lineId) => {
        const id = nanoid(8);
        set((s) => {
          const line = s.lines[lineId];
          if (!line) return s;
          const station: Station = {
            id,
            name: `駅 ${Object.keys(s.stations).length + 1}`,
            x,
            y,
            lineIds: [lineId],
            notes: '',
            links: [],
            status: 'todo',
            labelDir: 'n',
          };
          return {
            stations: { ...s.stations, [id]: station },
            lines: {
              ...s.lines,
              [lineId]: { ...line, stationIds: [...line.stationIds, id] },
            },
            ...selFields([id], []),
          };
        });
        return id;
      },

      addStationAt: (x, y, lineId, insertIndex) => {
        const id = nanoid(8);
        set((s) => {
          const line = s.lines[lineId];
          if (!line) return s;
          const station: Station = {
            id,
            name: `駅 ${Object.keys(s.stations).length + 1}`,
            x,
            y,
            lineIds: [lineId],
            notes: '',
            links: [],
            status: 'todo',
            labelDir: 'n',
          };
          const idx = Math.max(0, Math.min(line.stationIds.length, insertIndex));
          const newStationIds = [
            ...line.stationIds.slice(0, idx),
            id,
            ...line.stationIds.slice(idx),
          ];
          return {
            stations: { ...s.stations, [id]: station },
            lines: {
              ...s.lines,
              [lineId]: { ...line, stationIds: newStationIds },
            },
            ...selFields([id], []),
          };
        });
        return id;
      },

      attachStationToLine: (stationId, lineId) =>
        set((s) => {
          const station = s.stations[stationId];
          const line = s.lines[lineId];
          if (!station || !line) return s;
          if (station.lineIds.includes(lineId)) return s;
          return {
            stations: {
              ...s.stations,
              [stationId]: { ...station, lineIds: [...station.lineIds, lineId] },
            },
            lines: {
              ...s.lines,
              [lineId]: { ...line, stationIds: [...line.stationIds, stationId] },
            },
          };
        }),

      detachStationFromLine: (stationId, lineId) =>
        set((s) => {
          const station = s.stations[stationId];
          const line = s.lines[lineId];
          if (!station || !line) return s;
          const remainingLineIds = station.lineIds.filter((l) => l !== lineId);
          const newLines = {
            ...s.lines,
            [lineId]: {
              ...line,
              stationIds: line.stationIds.filter((sid) => sid !== stationId),
            },
          };
          if (remainingLineIds.length === 0) {
            const { [stationId]: _drop, ...rest } = s.stations;
            return {
              stations: rest,
              lines: newLines,
              selectedStationId:
                s.selectedStationId === stationId ? null : s.selectedStationId,
            };
          }
          return {
            stations: {
              ...s.stations,
              [stationId]: { ...station, lineIds: remainingLineIds },
            },
            lines: newLines,
          };
        }),

      moveStation: (id, x, y) =>
        set((s) =>
          s.stations[id]
            ? { stations: { ...s.stations, [id]: { ...s.stations[id], x, y } } }
            : s
        ),

      renameStation: (id, name) =>
        set((s) =>
          s.stations[id]
            ? { stations: { ...s.stations, [id]: { ...s.stations[id], name } } }
            : s
        ),

      updateStationNotes: (id, notes) =>
        set((s) =>
          s.stations[id]
            ? { stations: { ...s.stations, [id]: { ...s.stations[id], notes } } }
            : s
        ),

      setStationStatus: (id, status) =>
        set((s) =>
          s.stations[id]
            ? { stations: { ...s.stations, [id]: { ...s.stations[id], status } } }
            : s
        ),

      setStationLabelDir: (id, dir) =>
        set((s) =>
          s.stations[id]
            ? {
                stations: {
                  ...s.stations,
                  [id]: { ...s.stations[id], labelDir: dir },
                },
              }
            : s
        ),

      setStationShape: (id, shape) =>
        set((s) =>
          s.stations[id]
            ? {
                stations: {
                  ...s.stations,
                  [id]: { ...s.stations[id], shape },
                },
              }
            : s
        ),

      setStationColor: (id, color) =>
        set((s) => {
          const st = s.stations[id];
          if (!st) return s;
          const next: Station = { ...st };
          if (color === null) delete next.color;
          else next.color = color;
          return { stations: { ...s.stations, [id]: next } };
        }),

      // Link/unlink the station to a Constella canvas card (back-reference on the
      // card is maintained by the DetailPanel, which has both stores).
      setStationCard: (id, cardId) =>
        set((s) => {
          const st = s.stations[id];
          if (!st) return s;
          const next: Station = { ...st };
          if (cardId === null) delete next.cardId;
          else next.cardId = cardId;
          return { stations: { ...s.stations, [id]: next } };
        }),

      // Card → station jump: select the station + activate its line, then leave a
      // focusStationId signal for the Canvas to center on (and consume).
      requestStationFocus: (id) =>
        set((s) => {
          const st = s.stations[id];
          if (!st) return s;
          return {
            focusStationId: id,
            ...selFields([id], []),
            selectedAnnotationId: null,
            activeLineId: st.lineIds[0] ?? s.activeLineId,
          };
        }),
      consumeStationFocus: () => set({ focusStationId: null }),

      addStationLink: (id, url, label) =>
        set((s) => {
          const st = s.stations[id];
          if (!st) return s;
          return {
            stations: {
              ...s.stations,
              [id]: { ...st, links: [...st.links, { url, label }] },
            },
          };
        }),

      removeStationLink: (id, index) =>
        set((s) => {
          const st = s.stations[id];
          if (!st) return s;
          return {
            stations: {
              ...s.stations,
              [id]: { ...st, links: st.links.filter((_, i) => i !== index) },
            },
          };
        }),

      removeStation: (id) =>
        set((s) => {
          const station = s.stations[id];
          if (!station) return s;
          const { [id]: _drop, ...rest } = s.stations;
          const newLines: Record<string, Line> = {};
          for (const line of Object.values(s.lines)) {
            newLines[line.id] = {
              ...line,
              stationIds: line.stationIds.filter((sid) => sid !== id),
            };
          }
          // Repair trains referencing the removed station.
          const newTrains: Record<string, Train> = {};
          for (const train of Object.values(s.trains)) {
            const lineIds = newLines[train.lineId]?.stationIds ?? [];
            if (lineIds.length < 2) continue;
            let from = train.fromStationId;
            let to = train.toStationId;
            if (from === id) from = lineIds[0];
            if (to === id) to = lineIds[lineIds.length - 1];
            if (from === to) continue;
            if (!lineIds.includes(from) || !lineIds.includes(to)) continue;
            newTrains[train.id] = { ...train, fromStationId: from, toStationId: to };
          }
          return {
            stations: rest,
            lines: newLines,
            trains: newTrains,
            trainOrder: s.trainOrder.filter((tid) => newTrains[tid]),
            selectedStationId:
              s.selectedStationId === id ? null : s.selectedStationId,
          };
        }),

      selectStation: (id) =>
        set(() => (id ? selFields([id], []) : { selectedStationId: null, selectedStationIds: [] })),

      setSelection: (stationIds, annotationIds) => set(selFields(stationIds, annotationIds)),
      toggleStationSelection: (id) =>
        set((s) => {
          const has = s.selectedStationIds.includes(id);
          const next = has ? s.selectedStationIds.filter((x) => x !== id) : [...s.selectedStationIds, id];
          return selFields(next, s.selectedAnnotationIds);
        }),
      toggleAnnotationSelection: (id) =>
        set((s) => {
          const has = s.selectedAnnotationIds.includes(id);
          const next = has ? s.selectedAnnotationIds.filter((x) => x !== id) : [...s.selectedAnnotationIds, id];
          return selFields(s.selectedStationIds, next);
        }),
      moveSelectedBy: (dx, dy) =>
        set((s) => {
          if (dx === 0 && dy === 0) return s;
          const stations = { ...s.stations };
          for (const id of s.selectedStationIds) { const st = stations[id]; if (st) stations[id] = { ...st, x: st.x + dx, y: st.y + dy }; }
          const annotations = { ...s.annotations };
          for (const id of s.selectedAnnotationIds) { const a = annotations[id]; if (a) annotations[id] = { ...a, x: a.x + dx, y: a.y + dy }; }
          return { stations, annotations };
        }),
      removeSelected: () => {
        const { selectedStationIds, selectedAnnotationIds } = get();
        for (const id of [...selectedStationIds]) get().removeStation(id);
        for (const id of [...selectedAnnotationIds]) get().removeAnnotation(id);
        set(selFields([], []));
      },

      setToolMode: (mode) =>
        set((s) => ({
          toolMode: mode === 'add' && !s.activeLineId ? 'select' : mode,
        })),

      toggleAddMode: () =>
        set((s) => ({
          toolMode:
            s.toolMode === 'add'
              ? 'select'
              : s.activeLineId
                ? 'add'
                : 'select',
        })),

      addTrain: (lineId, name) => {
        let createdId: string | null = null;
        set((s) => {
          const line = s.lines[lineId];
          if (!line || line.stationIds.length < 2) return s;
          const id = nanoid(8);
          const count =
            Object.values(s.trains).filter((t) => t.lineId === lineId).length +
            1;
          const finalName = name?.trim() || `便 ${count}`;
          const train: Train = {
            id,
            lineId,
            name: finalName,
            notes: '',
            fromStationId: line.stationIds[0],
            toStationId: line.stationIds[line.stationIds.length - 1],
          };
          createdId = id;
          return {
            trains: { ...s.trains, [id]: train },
            trainOrder: [...s.trainOrder, id],
          };
        });
        return createdId;
      },

      renameTrain: (id, name) =>
        set((s) =>
          s.trains[id]
            ? { trains: { ...s.trains, [id]: { ...s.trains[id], name } } }
            : s
        ),

      updateTrainNotes: (id, notes) =>
        set((s) =>
          s.trains[id]
            ? { trains: { ...s.trains, [id]: { ...s.trains[id], notes } } }
            : s
        ),

      setTrainRange: (id, fromStationId, toStationId) =>
        set((s) => {
          const train = s.trains[id];
          if (!train) return s;
          const line = s.lines[train.lineId];
          if (!line) return s;
          const validFrom = line.stationIds.includes(fromStationId)
            ? fromStationId
            : train.fromStationId;
          const validTo = line.stationIds.includes(toStationId)
            ? toStationId
            : train.toStationId;
          return {
            trains: {
              ...s.trains,
              [id]: { ...train, fromStationId: validFrom, toStationId: validTo },
            },
          };
        }),

      setTrainColor: (id, color) =>
        set((s) => {
          const train = s.trains[id];
          if (!train) return s;
          const next: Train = { ...train };
          if (color === null) {
            delete next.color;
          } else {
            next.color = color;
          }
          return { trains: { ...s.trains, [id]: next } };
        }),

      setTrainShape: (id, shape) =>
        set((s) =>
          s.trains[id]
            ? { trains: { ...s.trains, [id]: { ...s.trains[id], shape } } }
            : s
        ),

      removeTrain: (id) =>
        set((s) => {
          if (!s.trains[id]) return s;
          const { [id]: _drop, ...rest } = s.trains;
          const wasPicking = s.pickingTrainEndpoint?.trainId === id;
          return {
            trains: rest,
            trainOrder: s.trainOrder.filter((tid) => tid !== id),
            pickingTrainEndpoint: wasPicking ? null : s.pickingTrainEndpoint,
          };
        }),

      startPickingTrainEndpoint: (trainId, endpoint) =>
        set((s) => {
          const train = s.trains[trainId];
          if (!train) return s;
          // 路線をアクティブにしておく（ハイライトのため）
          return {
            pickingTrainEndpoint: { trainId, endpoint },
            activeLineId: train.lineId,
          };
        }),

      cancelPickingTrainEndpoint: () =>
        set({ pickingTrainEndpoint: null }),

      addArea: (x, y, width, height, text, color) => {
        const id = nanoid(8);
        set((s) => {
          const finalColor = color ?? PALETTE[s.annotationOrder.length % PALETTE.length];
          const ann: AreaAnnotation = {
            kind: 'area',
            id,
            x,
            y,
            width: Math.max(40, width),
            height: Math.max(30, height),
            color: finalColor,
            text: text ?? 'エリア',
          };
          return {
            annotations: { ...s.annotations, [id]: ann },
            annotationOrder: [...s.annotationOrder, id],
            ...selFields([], [id]),
          };
        });
        return id;
      },

      addLabel: (x, y, text) => {
        const id = nanoid(8);
        set((s) => {
          const ann: LabelAnnotation = {
            kind: 'label',
            id,
            x,
            y,
            text: text ?? 'テキスト',
          };
          return {
            annotations: { ...s.annotations, [id]: ann },
            annotationOrder: [...s.annotationOrder, id],
            ...selFields([], [id]),
          };
        });
        return id;
      },

      addImage: (x, y, src, width, height) => {
        const id = nanoid(8);
        set((s) => {
          const ann: ImageAnnotation = {
            kind: 'image',
            id,
            x,
            y,
            width,
            height,
            src,
          };
          return {
            annotations: { ...s.annotations, [id]: ann },
            annotationOrder: [...s.annotationOrder, id],
            ...selFields([], [id]),
          };
        });
        return id;
      },

      moveAnnotation: (id, x, y) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann) return s;
          return {
            annotations: { ...s.annotations, [id]: { ...ann, x, y } },
          };
        }),

      resizeAnnotation: (id, x, y, width, height) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann || ann.kind === 'label') return s;
          return {
            annotations: {
              ...s.annotations,
              [id]: {
                ...ann,
                x,
                y,
                width: Math.max(20, width),
                height: Math.max(16, height),
              },
            },
          };
        }),

      updateAnnotationText: (id, text) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann || ann.kind === 'image') return s;
          return {
            annotations: { ...s.annotations, [id]: { ...ann, text } },
          };
        }),

      setAnnotationColor: (id, color) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann) return s;
          if (ann.kind === 'image') return s;
          return {
            annotations: { ...s.annotations, [id]: { ...ann, color } },
          };
        }),

      setAnnotationFontSize: (id, fontSize) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann || ann.kind !== 'label') return s;
          return {
            annotations: {
              ...s.annotations,
              [id]: { ...ann, fontSize: Math.max(8, Math.min(72, fontSize)) },
            },
          };
        }),

      setAnnotationFontWeight: (id, weight) =>
        set((s) => {
          const ann = s.annotations[id];
          if (!ann || ann.kind !== 'label') return s;
          return {
            annotations: {
              ...s.annotations,
              [id]: { ...ann, fontWeight: weight },
            },
          };
        }),

      removeAnnotation: (id) =>
        set((s) => {
          if (!s.annotations[id]) return s;
          const { [id]: _drop, ...rest } = s.annotations;
          return {
            annotations: rest,
            annotationOrder: s.annotationOrder.filter((aid) => aid !== id),
            selectedAnnotationId:
              s.selectedAnnotationId === id ? null : s.selectedAnnotationId,
          };
        }),

      selectAnnotation: (id) =>
        set(() => (id ? selFields([], [id]) : { selectedAnnotationId: null, selectedAnnotationIds: [] })),

      renameWorkspace: (id, name) =>
        set((s) => {
          if (!s.workspaceMeta[id]) return s;
          const trimmed = name.trim();
          if (!trimmed) return s;
          return {
            workspaceMeta: {
              ...s.workspaceMeta,
              [id]: { ...s.workspaceMeta[id], name: trimmed },
            },
          };
        }),

      // Scope the route map to a master project: switch to that project's active
      // plan (the last one viewed, else its first), creating a first plan if the
      // project has none yet. Driven by the host bridge on master-project change.
      bindWorkspaceToProject: (projectId) =>
        set((s) => {
          // Already viewing a plan of this project → just record the scope.
          if (s.workspaceMeta[s.activeWorkspaceId]?.projectId === projectId) {
            return {
              activeProjectId: projectId,
              activePlanByProject: { ...s.activePlanByProject, [projectId]: s.activeWorkspaceId },
            };
          }
          const currentSnapshot = snapshotOf(s);
          const plansOf = s.workspaceOrder.filter((id) => s.workspaceMeta[id]?.projectId === projectId);
          let target = s.activePlanByProject[projectId];
          if (!target || s.workspaceMeta[target]?.projectId !== projectId) target = plansOf[0];
          if (!target) {
            // First time on this project — create its first plan.
            const id = nanoid(8);
            return {
              ...emptyWorkspaceSnapshot(),
              workspaces: { ...s.workspaces, [s.activeWorkspaceId]: currentSnapshot, [id]: emptyWorkspaceSnapshot() },
              workspaceMeta: { ...s.workspaceMeta, [id]: { id, name: 'プラン 1', projectId } },
              workspaceOrder: [...s.workspaceOrder, id],
              activeWorkspaceId: id,
              activeProjectId: projectId,
              activePlanByProject: { ...s.activePlanByProject, [projectId]: id },
              toolMode: 'select',
              pickingTrainEndpoint: null,
            };
          }
          return {
            ...flatFromSnapshot(s.workspaces[target] ?? emptyWorkspaceSnapshot()),
            workspaces: { ...s.workspaces, [s.activeWorkspaceId]: currentSnapshot },
            activeWorkspaceId: target,
            activeProjectId: projectId,
            activePlanByProject: { ...s.activePlanByProject, [projectId]: target },
            toolMode: 'select',
            pickingTrainEndpoint: null,
          };
        }),

      // Create a new plan under the current project and switch to it.
      addPlan: (name) => {
        let created: string | null = null;
        set((s) => {
          const pid = s.activeProjectId;
          if (!pid) return s;
          const id = nanoid(8);
          created = id;
          const count = s.workspaceOrder.filter((w) => s.workspaceMeta[w]?.projectId === pid).length + 1;
          return {
            ...emptyWorkspaceSnapshot(),
            workspaces: { ...s.workspaces, [s.activeWorkspaceId]: snapshotOf(s), [id]: emptyWorkspaceSnapshot() },
            workspaceMeta: { ...s.workspaceMeta, [id]: { id, name: name?.trim() || `プラン ${count}`, projectId: pid } },
            workspaceOrder: [...s.workspaceOrder, id],
            activeWorkspaceId: id,
            activePlanByProject: { ...s.activePlanByProject, [pid]: id },
            toolMode: 'select',
            pickingTrainEndpoint: null,
          };
        });
        return created;
      },

      // Switch to another plan (of the current project).
      switchPlan: (id) =>
        set((s) => {
          if (id === s.activeWorkspaceId) return s;
          const meta = s.workspaceMeta[id];
          if (!meta) return s;
          return {
            ...flatFromSnapshot(s.workspaces[id] ?? emptyWorkspaceSnapshot()),
            workspaces: { ...s.workspaces, [s.activeWorkspaceId]: snapshotOf(s) },
            activeWorkspaceId: id,
            activePlanByProject: { ...s.activePlanByProject, [meta.projectId]: id },
            toolMode: 'select',
            pickingTrainEndpoint: null,
          };
        }),

      // Remove a plan; refuses if it is the project's only plan. If it was active,
      // switch to a sibling plan of the same project.
      removePlan: (id) =>
        set((s) => {
          const meta = s.workspaceMeta[id];
          if (!meta) return s;
          const pid = meta.projectId;
          const siblings = s.workspaceOrder.filter((w) => s.workspaceMeta[w]?.projectId === pid);
          if (siblings.length <= 1) return s;
          const workspaceOrder = s.workspaceOrder.filter((w) => w !== id);
          const { [id]: _m, ...workspaceMeta } = s.workspaceMeta;
          const { [id]: _s, ...workspaces } = s.workspaces;
          if (s.activeWorkspaceId !== id) {
            return { workspaceOrder, workspaceMeta, workspaces };
          }
          const nextId = siblings.find((w) => w !== id) as string;
          return {
            ...flatFromSnapshot(workspaces[nextId] ?? emptyWorkspaceSnapshot()),
            workspaceOrder,
            workspaceMeta,
            workspaces,
            activeWorkspaceId: nextId,
            activePlanByProject: { ...s.activePlanByProject, [pid]: nextId },
            toolMode: 'select',
            pickingTrainEndpoint: null,
          };
        }),

      // Remove every plan of a deleted master project (never the active one — the
      // caller switches the active master away first).
      dropProjectPlans: (projectId) =>
        set((s) => {
          const removing = new Set(
            s.workspaceOrder.filter((w) => s.workspaceMeta[w]?.projectId === projectId && w !== s.activeWorkspaceId)
          );
          if (removing.size === 0) {
            const { [projectId]: _drop, ...activePlanByProject } = s.activePlanByProject;
            return { activePlanByProject };
          }
          const workspaceOrder = s.workspaceOrder.filter((w) => !removing.has(w));
          const workspaceMeta = { ...s.workspaceMeta };
          const workspaces = { ...s.workspaces };
          for (const w of removing) { delete workspaceMeta[w]; delete workspaces[w]; }
          const { [projectId]: _drop, ...activePlanByProject } = s.activePlanByProject;
          return { workspaceOrder, workspaceMeta, workspaces, activePlanByProject };
        }),

      resetAll: () =>
        set((s) => ({
          stations: {},
          lines: {},
          lineOrder: [],
          trains: {},
          trainOrder: [],
          annotations: {},
          annotationOrder: [],
          activeLineId: null,
          selectedStationId: null,
          selectedAnnotationId: null,
          workspaces: {
            ...s.workspaces,
            [s.activeWorkspaceId]: emptyWorkspaceSnapshot(),
          },
          toolMode: 'select',
          pickingTrainEndpoint: null,
        })),
      };
    },
    {
      // Track only the data (not selection/UI), so selecting never creates an
      // undo step. A leading throttle collapses a drag's many moveStation calls
      // into a single undo step.
      limit: 100,
      partialize: (s: Store) => ({
        stations: s.stations,
        lines: s.lines,
        lineOrder: s.lineOrder,
        trains: s.trains,
        trainOrder: s.trainOrder,
        annotations: s.annotations,
        annotationOrder: s.annotationOrder,
      }),
      equality: (a, b) =>
        a.stations === b.stations &&
        a.lines === b.lines &&
        a.lineOrder === b.lineOrder &&
        a.trains === b.trains &&
        a.trainOrder === b.trainOrder &&
        a.annotations === b.annotations &&
        a.annotationOrder === b.annotationOrder,
      handleSet: (handleSet) => {
        let last = 0;
        return (state) => {
          const now = Date.now();
          if (now - last >= 450) {
            last = now;
            handleSet(state);
          }
        };
      },
    }
    ),
    {
      name: 'mindtrain-storage',
      version: 5,
      // Persisted into Constella's SQLite DB (see ../persist) instead of
      // localStorage, so 路線図 data is unified with the rest of the app.
      storage: createJSONStorage(() => constellaMindtrainStorage),
      migrate: (persisted: unknown, version: number) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        // Chain migrations so an old version is upgraded through every step.
        let cur = persisted as Record<string, unknown>;
        if (version < 2) {
          const old = cur;
          const id = nanoid(8);
          const snap: WorkspaceSnapshot = {
            stations: (old.stations as WorkspaceSnapshot['stations']) ?? {},
            lines: (old.lines as WorkspaceSnapshot['lines']) ?? {},
            lineOrder: (old.lineOrder as string[]) ?? [],
            trains: (old.trains as WorkspaceSnapshot['trains']) ?? {},
            trainOrder: (old.trainOrder as string[]) ?? [],
            annotations: {},
            annotationOrder: [],
            activeLineId: (old.activeLineId as string | null) ?? null,
            selectedStationId:
              (old.selectedStationId as string | null) ?? null,
            selectedAnnotationId: null,
          };
          cur = {
            ...snap,
            workspaces: { [id]: snap },
            workspaceMeta: { [id]: { id, name: 'ワークスペース 1' } },
            workspaceOrder: [id],
            activeWorkspaceId: id,
            toolMode: (old.toolMode as ToolMode) ?? 'select',
            pickingTrainEndpoint:
              (old.pickingTrainEndpoint as PickingTrainEndpoint | null) ?? null,
          };
        }
        if (version < 3) {
          // v2 -> v3: 既存ワークスペースに annotations を補完
          const old = cur;
          const workspaces = (old.workspaces ?? {}) as Record<
            string,
            Partial<WorkspaceSnapshot>
          >;
          const filledWorkspaces: Record<string, WorkspaceSnapshot> = {};
          for (const [wid, ws] of Object.entries(workspaces)) {
            filledWorkspaces[wid] = {
              stations: ws.stations ?? {},
              lines: ws.lines ?? {},
              lineOrder: ws.lineOrder ?? [],
              trains: ws.trains ?? {},
              trainOrder: ws.trainOrder ?? [],
              annotations: ws.annotations ?? {},
              annotationOrder: ws.annotationOrder ?? [],
              activeLineId: ws.activeLineId ?? null,
              selectedStationId: ws.selectedStationId ?? null,
              selectedAnnotationId: ws.selectedAnnotationId ?? null,
            };
          }
          cur = {
            ...old,
            annotations: (old.annotations ?? {}) as Record<string, Annotation>,
            annotationOrder: (old.annotationOrder ?? []) as string[],
            selectedAnnotationId:
              (old.selectedAnnotationId as string | null) ?? null,
            workspaces: filledWorkspaces,
          };
        }
        if (version < 4) {
          // v3 -> v4: bind the existing active workspace to the global default
          // master project id ('master-default'), so the legacy route map becomes
          // the default master project's map under the new unified hierarchy.
          const old = cur;
          const activeId = old.activeWorkspaceId as string | undefined;
          if (activeId && activeId !== 'master-default') {
            const meta = { ...((old.workspaceMeta as Record<string, { id: string; name: string; projectId?: string }>) ?? {}) };
            const workspaces = { ...((old.workspaces as Record<string, WorkspaceSnapshot>) ?? {}) };
            const order = [...((old.workspaceOrder as string[]) ?? [])];
            meta['master-default'] = { id: 'master-default', name: meta[activeId]?.name ?? 'メイン' };
            delete meta[activeId];
            if (workspaces[activeId]) { workspaces['master-default'] = workspaces[activeId]; delete workspaces[activeId]; }
            const idx = order.indexOf(activeId);
            if (idx >= 0) order[idx] = 'master-default'; else order.unshift('master-default');
            cur = { ...old, workspaceMeta: meta, workspaces, workspaceOrder: order, activeWorkspaceId: 'master-default' };
          }
        }
        if (version < 5) {
          // v4 -> v5: plans-under-project. Tag every existing workspace (plan) with
          // a projectId. The v4 model was 1:1 (workspace id === master id), so each
          // legacy plan's project is its own id; the host reconciliation creates a
          // master per distinct projectId so nothing becomes unreachable.
          const old = cur;
          const order = (old.workspaceOrder as string[]) ?? [];
          const srcMeta = (old.workspaceMeta as Record<string, { id: string; name: string; projectId?: string }>) ?? {};
          const meta: Record<string, WorkspaceMeta> = {};
          const activePlanByProject: Record<string, string> = {};
          for (const id of order) {
            const m = srcMeta[id];
            if (!m) continue;
            const projectId = m.projectId ?? id;
            meta[id] = { id, name: m.name, projectId };
            if (!activePlanByProject[projectId]) activePlanByProject[projectId] = id;
          }
          const activeId = (old.activeWorkspaceId as string) ?? 'master-default';
          const activeProjectId = meta[activeId]?.projectId ?? 'master-default';
          cur = { ...old, workspaceMeta: meta, activeProjectId, activePlanByProject };
        }
        return cur;
      },
    }
  )
);

// Don't let the async SQLite rehydration become an undoable step.
useStore.persist.onFinishHydration(() => {
  useStore.temporal.getState().clear();
});

// Undo history is per-workspace: switching/creating/deleting a workspace
// replaces the whole dataset, so reset history to avoid cross-workspace undo.
useStore.subscribe((s, prev) => {
  if (s.activeWorkspaceId !== prev.activeWorkspaceId) {
    useStore.temporal.getState().clear();
    useStore.setState({ selectedStationIds: [], selectedAnnotationIds: [] });
  }
});
