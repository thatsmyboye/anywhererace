import type { RacerAppearance } from '../palette';

/**
 * The racer's identity chip: colour plus ring pattern, matching the map marker.
 *
 * The pattern is not decoration. It is the second channel that makes a forty
 * racer field readable for a viewer who cannot distinguish two adjacent hues,
 * and it has to appear everywhere the colour does — otherwise the timing tower
 * becomes the one place the field is ambiguous.
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
  const radius = size / 2 - 1.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={radius - 2} fill={appearance.color} />
      {appearance.pattern === 'double' ? (
        <>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={stroke}
            strokeWidth={0.9}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius - 1.6}
            fill="none"
            stroke={stroke}
            strokeWidth={0.9}
          />
        </>
      ) : (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap={appearance.pattern === 'dotted' ? 'round' : 'butt'}
          strokeDasharray={DASH_ARRAY[appearance.pattern]}
        />
      )}
      {label === undefined ? null : (
        <text
          x={size / 2}
          y={size / 2}
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

const DASH_ARRAY: Record<RacerAppearance['pattern'], string | undefined> = {
  solid: undefined,
  dashed: '4 3',
  dotted: '0.5 3',
  double: undefined,
};
