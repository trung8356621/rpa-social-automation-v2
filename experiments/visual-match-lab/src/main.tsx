import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiveDomLab } from './LiveDomLab';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <LiveDomLab />
    </React.StrictMode>
  );
}
