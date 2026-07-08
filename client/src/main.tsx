/**
 * Client entry (spec §3.7). Mounts the React app and loads the single design-
 * token stylesheet. Vite serves this in dev (proxying /api to the Node server)
 * and bundles it into dist/client for the Node server to serve statically.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('mission-dashboard: #root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
