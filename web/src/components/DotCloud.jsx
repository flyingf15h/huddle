// A small morphing dot cloud, for the home screen and empty screens.
import { useEffect, useRef } from 'react';
import { mountCloud } from '../lib/dotcloud.js';

export default function DotCloud({ size = 150, n, shapes, every, className = '' }) {
  const ref = useRef(null);
  useEffect(() => mountCloud(ref.current, { n: n || Math.round(size * size / 22), shapes, every }), [size, n, every]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className={'dotcloud ' + className} style={{ width: size, height: size }} aria-hidden="true" />;
}
