import { useEffect, useRef } from 'react';
import { renderTrainShape } from './shapes';
import type { TrainShape } from '../../types';

interface Props {
  pathD: string;
  color: string;
  durationMs: number;
  phase?: number;
  name?: string;
  shape?: TrainShape;
}

export function TrainSprite({
  pathD,
  color,
  durationMs,
  phase = 0,
  name,
  shape = 'capsule',
}: Props) {
  const rectGroupRef = useRef<SVGGElement>(null);
  const labelGroupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const path = pathRef.current;
      const rectG = rectGroupRef.current;
      const labelG = labelGroupRef.current;
      if (path && rectG) {
        const total = path.getTotalLength();
        if (total > 0 && durationMs > 0) {
          const elapsed = now - start;
          const t =
            ((elapsed + phase * durationMs) % durationMs) / durationMs;
          const dist = t * total;
          const pos = path.getPointAtLength(dist);
          const aheadDist = Math.min(dist + 1, total);
          const ahead = path.getPointAtLength(aheadDist);
          let angle =
            (Math.atan2(ahead.y - pos.y, ahead.x - pos.x) * 180) / Math.PI;
          if (!Number.isFinite(angle)) angle = 0;
          rectG.setAttribute(
            'transform',
            `translate(${pos.x} ${pos.y}) rotate(${angle})`
          );
          if (labelG) {
            labelG.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pathD, durationMs, phase]);

  return (
    <>
      <path
        ref={pathRef}
        d={pathD}
        fill="none"
        stroke="none"
        pointerEvents="none"
      />
      <g ref={rectGroupRef} pointerEvents="none">
        {renderTrainShape({
          shape,
          fill: color,
          stroke: '#ffffff',
          strokeWidth: 1.5,
        })}
      </g>
      {name && (
        <g ref={labelGroupRef} pointerEvents="none">
          <text
            x={0}
            y={-12}
            textAnchor="middle"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize={11}
            fontWeight={700}
            fill="#1a1d22"
            stroke="#ffffff"
            strokeWidth={3}
            paintOrder="stroke"
            style={{ letterSpacing: '0.01em' }}
          >
            {name}
          </text>
        </g>
      )}
    </>
  );
}
