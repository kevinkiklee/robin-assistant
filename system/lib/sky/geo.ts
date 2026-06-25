import { SKY } from './constants.ts';

const rad = Math.PI / 180;
const R = 6371; // km

export function destPoint(lat: number, lng: number, bearingDeg: number, distKm: number) {
  const d = distKm / R;
  const t = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lng * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / rad, lng: (((l2 / rad + 540) % 360) - 180) };
}

export function samplePoints(origin: { lat: number; lng: number }, azimuth: number) {
  const out: Array<{ distKm: number; bearing: number; lat: number; lng: number }> = [];
  for (const distKm of SKY.sampleDistancesKm) {
    const bearings =
      distKm >= SKY.farFieldKm
        ? [azimuth - SKY.fanDegrees, azimuth, azimuth + SKY.fanDegrees]
        : [azimuth];
    for (const b of bearings) {
      const bearing = (b + 360) % 360;
      const { lat, lng } = distKm === 0 ? origin : destPoint(origin.lat, origin.lng, bearing, distKm);
      out.push({ distKm, bearing, lat, lng });
    }
  }
  return out;
}
