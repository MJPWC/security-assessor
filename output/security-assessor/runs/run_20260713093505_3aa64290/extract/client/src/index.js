import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  // Removing React.StrictMode to prevent double-mounting in development,
  // which causes sessions to be initialized twice.
  // <React.StrictMode>
    <App />
  // </React.StrictMode>
);

