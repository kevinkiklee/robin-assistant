export const SKY = {
  origin: { lat: 40.764, lng: -73.923 }, // Astoria, Queens
  sampleDistancesKm: [0, 25, 50, 90, 120],
  fanDegrees: 12,
  farFieldKm: 90, // samples at/beyond → horizon-gap zone
  nearFieldKm: 50, // samples at/below → canvas zone
  gapLowCloudMaxPct: 25, // far-field min low-cloud below this ⇒ gap
  bankLowCloudMinPct: 60, // far-field min low-cloud above this ⇒ bank
  canvasBandPct: [25, 70] as [number, number], // near-field canvas sweet spot
  canvasEmptyPct: 15, // canvas below this ⇒ "clear, no colour"
  canvasMidWeight: 0.7, // mid cloud counts 0.7× high as a catching canvas
  fogAlertMinIndex: 6, // ≥ "likely"
  sunsetLeadHours: [1.5, 5] as [number, number], // same-day sunset alert gate
  sunriseLeadHours: [6, 14] as [number, number], // night-before sunrise heads-up gate
  moonMinIllumination: 0.9, // full/near-full moon alert threshold
} as const;
