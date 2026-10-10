import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './skin-github.css';

// Apply a saved manual theme override before first paint. When none is saved we leave
// the attribute off and let the CSS `prefers-color-scheme` rule pick system default.
try { const t = localStorage.getItem('imd-theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch {}
// The look (classic or GitHub) is a second, independent choice; light/dark applies to both.
try { if (localStorage.getItem('imd-skin') === 'github') document.documentElement.dataset.skin = 'github'; } catch {}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
