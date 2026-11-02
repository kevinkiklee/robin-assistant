export const SKY = {
  sampleDistancesKm: [0, 25, 50, 90, 120],
  fanDegrees: 12,
  farFieldKm: 90, // samples at/beyond → horizon-gap zone
  nearFieldKm: 50, // samples at/below → canvas zone
  // Horizon (far field, toward the sun). The low sun has to get UNDER the deck
  // along the exact azimuth, so the on-axis samples carry the veto; the ±fan
  // mean is a second, looser check so one clear pixel in a broken deck doesn't
  // read as a gap. Tightened 2026-09-20: 60 alerts in 60 days, ~all "promising",
  // almost none delivered.
  gapLowCloudMaxPct: 15, // on-axis far-field MEAN low cloud below this ⇒ gap
  fanLowCloudMaxPct: 30, // whole-fan far-field mean low cloud must also be below this
  horizonMidCloudMaxPct: 50, // on-axis far-field mean mid cloud above this ⇒ deck blocks the sun
  bankLowCloudMinPct: 60, // on-axis far-field mean low cloud above this ⇒ bank
  // Canvas (near field, overhead). Both bounds enforced: below ⇒ nothing to
  // light, above ⇒ grey overcast. Mid cloud alone can't be the canvas.
  canvasBandPct: [30, 75] as [number, number],
  canvasMidMaxPct: 65, // near-field mean mid cloud above this ⇒ overcast, no colour
  overheadLowCloudMaxPct: 30, // near-field mean low cloud above this hides the canvas
  canvasEmptyPct: 15, // canvas below this ⇒ "clear, no colour"
  canvasMidWeight: 0.7, // mid cloud counts 0.7× high as a catching canvas
  alertMinConfidence: 0.55, // promising reads below this never alert
  fogAlertMinIndex: 6, // ≥ "likely" — AND the TAF must concur; the composite runs wet
  fogOnLeadHours: [0.3, 3.5] as [number, number], // pre-dawn METAR confirmation gate (4am/5am ticks)
  sunsetLeadHours: [1.5, 3.5] as [number, number], // same-day sunset alert gate (one 2h tick lands here every season)
  sunriseLeadHours: [6, 14] as [number, number], // night-before sunrise heads-up gate
  moonMinIllumination: 0.9, // full/near-full moon alert threshold
} as const;
