import { useEffect, useRef, useState } from 'react';

interface Props {
  anchorX: number;
  anchorY: number;
  dirX: number;
  dirY: number;
  gap: number;
  color: string;
  name: string;
  dim?: boolean;
}

export function LineLabel({
  anchorX,
  anchorY,
  dirX,
  dirY,
  gap,
  color,
  name,
  dim,
}: Props) {
  const textRef = useRef<SVGTextElement>(null);
  const [textWidth, setTextWidth] = useState<number>(0);

  useEffect(() => {
    if (textRef.current) {
      try {
        const w = textRef.current.getComputedTextLength();
        if (Number.isFinite(w) && w > 0) setTextWidth(w);
      } catch {
        // noop
      }
    }
  }, [name]);

  const padX = 10;
  const h = 20;
  const charW = (ch: string) => (/[　-鿿＀-￯]/.test(ch) ? 13 : 7);
  const fallbackW = Array.from(name).reduce((acc, ch) => acc + charW(ch), 0);
  const w = (textWidth > 0 ? textWidth : fallbackW) + padX * 2;

  // Project the rect onto the direction so the inner edge sits at `gap` from the anchor.
  const project = (w / 2) * Math.abs(dirX) + (h / 2) * Math.abs(dirY);
  const dist = gap + project;
  const cx = anchorX + dirX * dist;
  const cy = anchorY + dirY * dist;

  return (
    <g
      transform={`translate(${cx} ${cy})`}
      pointerEvents="none"
      opacity={dim ? 0.5 : 1}
    >
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={h / 2}
        fill={color}
      />
      <text
        ref={textRef}
        x={0}
        y={0.5}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight={700}
        fontSize={12}
        letterSpacing="0.01em"
      >
        {name}
      </text>
    </g>
  );
}
