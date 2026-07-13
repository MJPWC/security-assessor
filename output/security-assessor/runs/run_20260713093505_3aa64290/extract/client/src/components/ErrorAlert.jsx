import React from 'react';
import './ErrorAlert.css';

export default function ErrorAlert({ message, onRetry }) {
  return (
    <div className="error-alert">
      <div className="error-icon">⚠️</div>
      <div className="error-content">
        <h3>Error Loading Data</h3>
        <p>{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="retry-button">
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
