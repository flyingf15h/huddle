// One large dot cloud behind the whole app, slowly turning and drifting between shapes.
import { useEffect, useRef } from 'react';
import { mountCloud } from '../lib/dotcloud.js';

export default function BackCloud() {
  const ref = useRef(null);
  useEffect(() => mountCloud(ref.current, { n: 5200, shapes: ['torus', 'wave', 'sphere', 'blob'], every: 14, scale: .6, dot: 2.1 }), []);
  return <canvas id="backcloud" ref={ref} aria-hidden="true" />;
}
