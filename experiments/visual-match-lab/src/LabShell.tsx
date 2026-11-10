import React, { useState } from 'react';
import { App as StaticImageLab } from './App';
import { LiveDomLab } from './LiveDomLab';

type LabMode = 'static' | 'live';

export function LabShell() {
  const [mode, setMode] = useState<LabMode>('static');

  return <>
    <nav style={{ position: 'sticky', top: 0, zIndex: 100, display: 'flex', gap: 6, padding: '8px 24px', background: '#0b1220', borderBottom: '1px solid #334155' }} aria-label="Lab mode">
      <button onClick={() => setMode('static')} style={{ padding: '7px 14px', borderRadius: 4, border: '1px solid #475569', background: mode === 'static' ? '#0369a1' : '#1e293b', color: '#fff', cursor: 'pointer' }}>Static Image</button>
      <button onClick={() => setMode('live')} style={{ padding: '7px 14px', borderRadius: 4, border: '1px solid #475569', background: mode === 'live' ? '#0369a1' : '#1e293b', color: '#fff', cursor: 'pointer' }}>Live Browser</button>
    </nav>
    {mode === 'static' ? <StaticImageLab /> : <LiveDomLab />}
  </>;
}
