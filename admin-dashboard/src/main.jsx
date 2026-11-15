// Smart OPD Dashboard entry: one web app for every role (see RootApp.jsx).
// Only the shared tokens, font and login styles load here; each section brings its own stylesheet.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import RootApp from './RootApp.jsx';
import '@fontsource-variable/inter';
import '@staff/styles/tokens.css';
import '@staff/styles/portal.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <RootApp />
    </BrowserRouter>
  </React.StrictMode>,
);
