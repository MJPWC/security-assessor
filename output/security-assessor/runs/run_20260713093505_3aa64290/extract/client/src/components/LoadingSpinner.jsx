import React from 'react';
import './LoadingSpinner.css';

export default function LoadingSpinner({ text = 'Loading...' }) {
  return (
    <div className="loading-spinner">
      <div className="spinner"></div>
      <p>{text}</p>
    </div>
  );
}
