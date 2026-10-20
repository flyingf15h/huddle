import './app.css';
import './layout.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { S } from './lib/state.js';
import { applyTheme, themePref } from './lib/themes.js';

// paint the chosen theme before the first render, so the page never flashes the default
S.themePref = themePref();
applyTheme(S.themePref);

createRoot(document.getElementById('root')).render(<App />);
