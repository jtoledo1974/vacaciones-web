/**
 * Colour bands of people available, darker with more of them. Daily availability is a
 * narrow range of a large workforce (2027: 129–150 of 159), so a 0-to-total scale would
 * look uniform: seven bands of three people cover the part of the range that varies.
 */
export const availabilityBands = [
  { label: '≤130', atLeast: -Infinity },
  { label: '131–133', atLeast: 131 },
  { label: '134–136', atLeast: 134 },
  { label: '137–139', atLeast: 137 },
  { label: '140–142', atLeast: 140 },
  { label: '143–145', atLeast: 143 },
  { label: '≥146', atLeast: 146 },
] as const;

export function availabilityBand(available: number) {
  return availabilityBands.findLastIndex((band) => available >= band.atLeast);
}
