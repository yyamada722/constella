export interface StationLink {
  url: string;
  label: string;
}

export type StationStatus = 'todo' | 'doing' | 'done';

export type LabelDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const LABEL_DIRS: LabelDir[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
];

export type StationShape =
  | 'rounded-square'
  | 'circle'
  | 'square'
  | 'diamond'
  | 'hexagon'
  | 'triangle';

export const STATION_SHAPES: StationShape[] = [
  'rounded-square',
  'circle',
  'square',
  'diamond',
  'hexagon',
  'triangle',
];

export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  lineIds: string[];
  notes: string;
  links: StationLink[];
  status: StationStatus;
  labelDir?: LabelDir;
  shape?: StationShape;
  color?: string;
  cardId?: string; // linked Constella canvas card (路線図 ↔ カード連携)
}

export interface Line {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
}

export type TrainShape = 'capsule' | 'arrow' | 'double' | 'circle';

export const TRAIN_SHAPES: TrainShape[] = [
  'capsule',
  'arrow',
  'double',
  'circle',
];

export interface Train {
  id: string;
  lineId: string;
  name: string;
  notes?: string;
  fromStationId: string;
  toStationId: string;
  color?: string;
  shape?: TrainShape;
}

export interface AreaAnnotation {
  kind: 'area';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
}

export interface LabelAnnotation {
  kind: 'label';
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  color?: string;
  fontWeight?: number;
}

export interface ImageAnnotation {
  kind: 'image';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
}

export type Annotation = AreaAnnotation | LabelAnnotation | ImageAnnotation;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
