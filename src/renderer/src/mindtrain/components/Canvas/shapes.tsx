import type { StationShape, TrainShape } from '../../types';

interface StationShapeProps {
  shape: StationShape;
  cx: number;
  cy: number;
  size: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export function renderStationShape({
  shape,
  cx,
  cy,
  size,
  fill,
  stroke,
  strokeWidth,
}: StationShapeProps) {
  const half = size / 2;
  const common = {
    fill,
    stroke,
    strokeWidth,
    strokeLinejoin: 'round' as const,
  };
  switch (shape) {
    case 'circle':
      return <circle cx={cx} cy={cy} r={half} {...common} />;
    case 'square':
      return (
        <rect
          x={cx - half}
          y={cy - half}
          width={size}
          height={size}
          {...common}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`}
          {...common}
        />
      );
    case 'hexagon': {
      const r = half;
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = ((i * 60 - 30) * Math.PI) / 180;
        pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
      }
      return <polygon points={pts.join(' ')} {...common} />;
    }
    case 'triangle': {
      const r = half * 1.05;
      const pts = [0, 1, 2]
        .map((i) => {
          const a = ((i * 120 - 90) * Math.PI) / 180;
          return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
        })
        .join(' ');
      return <polygon points={pts} {...common} />;
    }
    case 'rounded-square':
    default:
      return (
        <rect
          x={cx - half}
          y={cy - half}
          width={size}
          height={size}
          rx={3}
          {...common}
        />
      );
  }
}

interface TrainShapeProps {
  shape: TrainShape;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export function renderTrainShape({
  shape,
  fill,
  stroke,
  strokeWidth,
}: TrainShapeProps) {
  const w = 14;
  const h = 7;
  const common = { fill, stroke, strokeWidth };
  switch (shape) {
    case 'arrow': {
      const tip = h / 2 + 1;
      return (
        <polygon
          points={`${-w / 2},${-h / 2} ${w / 2 - tip},${-h / 2} ${w / 2},0 ${w / 2 - tip},${h / 2} ${-w / 2},${h / 2}`}
          {...common}
          strokeLinejoin="round"
        />
      );
    }
    case 'double': {
      const carW = (w - 1.6) / 2;
      return (
        <g {...common}>
          <rect
            x={-w / 2}
            y={-h / 2}
            width={carW}
            height={h}
            rx={1.4}
            {...common}
          />
          <rect
            x={0.8}
            y={-h / 2}
            width={carW}
            height={h}
            rx={1.4}
            {...common}
          />
        </g>
      );
    }
    case 'circle': {
      const r = h / 2 + 1.5;
      return <circle cx={0} cy={0} r={r} {...common} />;
    }
    case 'capsule':
    default:
      return (
        <rect
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          rx={h / 2}
          {...common}
        />
      );
  }
}
