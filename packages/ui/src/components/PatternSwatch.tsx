import type { RacerAppearance } from '../palette';
import { markerShapePoints } from '../palette';

/**
 * The racer's identity chip: colour, ring pattern and body shape, matching the
 * map marker.
 *
 * The pattern and shape are not decoration. They are the second and third
 * channels that make a large field readable for a viewer who cannot distinguish
 * two adjacent hues, and they have to appear everywhere the colour does —
 * otherwise the timing tower becomes the one place the field is ambiguous.
 */
export const PatternSwatch = ({
  appearance,
  label,
  size = 20,
}: {
  appearance: RacerAppearance;
  label?: string;
  size?: number;
}) => {
  const stroke = appearance.color;
  const center = size / 2;
  const radius = size / 2 - 1.5;
  const points = markerShapePoints(appearance.shape, center, center, radius);
  const bodyPoints = markerShapePoints(appearance.shape, center, center, radius - 2);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-hidden="true"
    >
      <ShapeFill points={bodyPoints} center={center} radius={radius - 2} fill={appearance.color} />
      {appearance.pattern === 'double' ? (
        <>
          <ShapeOutline points={points} center={center} radius={radius} stroke={stroke} width={0.9} />
          <ShapeOutline
            points={markerShapePoints(appearance.shape, center, center, radius - 1.6)}
            center={center}
            radius={radius - 1.6}
            stroke={stroke}
            width={0.9}
          />
        </>
      ) : (
        <ShapeOutline
          points={points}
          center={center}
          radius={radius}
          stroke={stroke}
          width={2}
          linecap={appearance.pattern === 'dotted' ? 'round' : 'butt'}
          dash={DASH_ARRAY[appearance.pattern]}
        />
      )}
      {label === undefined ? null : (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.45}
          fontWeight={700}
          fill={appearance.contrastText}
        >
          {label}
        </text>
      )}
    </svg>
  );
};

/** A filled shape body — a polygon when there are points, a circle otherwise. */
const ShapeFill = ({
  points,
  center,
  radius,
  fill,
}: {
  points: [number, number][] | null;
  center: number;
  radius: number;
  fill: string;
}) =>
  points === null ? (
    <circle cx={center} cy={center} r={radius} fill={fill} />
  ) : (
    <polygon points={points.map(([x, y]) => `${x},${y}`).join(' ')} fill={fill} />
  );

/** A stroked shape outline, carrying the pattern channel as its dash array. */
const ShapeOutline = ({
  points,
  center,
  radius,
  stroke,
  width,
  linecap,
  dash,
}: {
  points: [number, number][] | null;
  center: number;
  radius: number;
  stroke: string;
  width: number;
  linecap?: 'round' | 'butt';
  dash?: string | undefined;
}) => {
  const common = {
    fill: 'none',
    stroke,
    strokeWidth: width,
    strokeLinecap: linecap,
    strokeLinejoin: 'round' as const,
    strokeDasharray: dash,
  };
  return points === null ? (
    <circle cx={center} cy={center} r={radius} {...common} />
  ) : (
    <polygon points={points.map(([x, y]) => `${x},${y}`).join(' ')} {...common} />
  );
};

const DASH_ARRAY: Record<RacerAppearance['pattern'], string | undefined> = {
  solid: undefined,
  dashed: '4 3',
  dotted: '0.5 3',
  double: undefined,
};
