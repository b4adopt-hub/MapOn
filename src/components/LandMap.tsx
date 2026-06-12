import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { kakao: any }
}

interface LandMapProps {
  /** land-lookup geomBoundary (GeoJSON MultiPolygon/Polygon, [lng,lat]) */
  geom: any;
  lat: number | null;
  lng: number | null;
  /** 표시용 라벨(주소 등) */
  label?: string | null;
}

const KAKAO_KEY = import.meta.env.VITE_KAKAO_MAP_KEY as string | undefined;
const SDK_ID = 'kakao-map-sdk';

/** SDK를 한 번만 로드하고 Promise로 준비 완료를 알림 */
function loadKakaoSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps) { resolve(); return; }
    if (!KAKAO_KEY) { reject(new Error('NO_KAKAO_KEY')); return; }

    const existing = document.getElementById(SDK_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => window.kakao.maps.load(() => resolve()));
      return;
    }
    const script = document.createElement('script');
    script.id = SDK_ID;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false`;
    script.async = true;
    script.onload = () => window.kakao.maps.load(() => resolve());
    script.onerror = () => reject(new Error('SDK_LOAD_FAILED'));
    document.head.appendChild(script);
  });
}

/** GeoJSON 링([lng,lat][])을 카카오 LatLng[]로 변환 */
function ringToLatLng(ring: number[][]): any[] {
  const kakao = window.kakao;
  return ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
}

/** MultiPolygon/Polygon에서 외곽 링들만 추출 */
function extractRings(geom: any): number[][][] {
  if (!geom) return [];
  if (geom.type === 'MultiPolygon') {
    // coordinates: [ [ [ring], [hole]... ], ... ]  → 각 폴리곤의 외곽링(0번)
    return geom.coordinates.map((poly: number[][][]) => poly[0]);
  }
  if (geom.type === 'Polygon') {
    return [geom.coordinates[0]];
  }
  return [];
}

export default function LandMap({ geom, lat, lng, label }: LandMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadKakaoSdk()
      .then(() => { if (!cancelled) setReady(true); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !ref.current || lat == null || lng == null) return;
    const kakao = window.kakao;

    const map = new kakao.maps.Map(ref.current, {
      center: new kakao.maps.LatLng(lat, lng),
      level: 3,
    });

    // 경계 폴리곤 그리기
    const rings = extractRings(geom);
    const allPaths = rings.map(ringToLatLng);
    const bounds = new kakao.maps.LatLngBounds();

    for (const path of allPaths) {
      const polygon = new kakao.maps.Polygon({
        path,
        strokeWeight: 2.5,
        strokeColor: '#1f5c4d',
        strokeOpacity: 0.95,
        strokeStyle: 'solid',
        fillColor: '#1f5c4d',
        fillOpacity: 0.18,
      });
      polygon.setMap(map);
      path.forEach((p: any) => bounds.extend(p));
    }

    // 중심 마커
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(lat, lng),
    });
    marker.setMap(map);

    if (label) {
      const iw = new kakao.maps.InfoWindow({
        content: `<div style="padding:5px 9px;font-size:12px;white-space:nowrap;">${label}</div>`,
      });
      iw.open(map, marker);
    }

    // 경계에 맞춰 화면 조정
    if (allPaths.length > 0) map.setBounds(bounds);

    // 지도 타입 컨트롤(일반/스카이뷰)
    const mapTypeControl = new kakao.maps.MapTypeControl();
    map.addControl(mapTypeControl, kakao.maps.ControlPosition.TOPRIGHT);
    const zoomControl = new kakao.maps.ZoomControl();
    map.addControl(zoomControl, kakao.maps.ControlPosition.RIGHT);
  }, [ready, geom, lat, lng, label]);

  if (err === 'NO_KAKAO_KEY') {
    return (
      <div className="map-fallback">
        지도 표시를 위해 카카오맵 키(VITE_KAKAO_MAP_KEY) 설정이 필요합니다.
      </div>
    );
  }
  if (err) {
    return <div className="map-fallback">지도를 불러오지 못했습니다.</div>;
  }

  return <div ref={ref} className="land-map" />;
}
