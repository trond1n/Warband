import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

import { App } from './App.tsx';
import './styles.css';

// The diff view only needs the base editor worker: it computes the diff.
// Highlighting runs without language workers, and nothing here is editable.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
