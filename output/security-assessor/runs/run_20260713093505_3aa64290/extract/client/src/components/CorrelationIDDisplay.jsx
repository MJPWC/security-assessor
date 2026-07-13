import React, { useState } from 'react';
import './CorrelationIDDisplay.css';

/**
 * CorrelationIDDisplay Component
 * Shows correlation ID with copy-to-clipboard functionality
 */
const CorrelationIDDisplay = ({ correlationID, compact = false }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(correlationID);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!correlationID) {
    return <span className="correlation-id-empty">—</span>;
  }

  if (compact) {
    // Show shortened version: YYYY-MM-DD-HHmm-agenttype
    const parts = correlationID.split('-');
    if (parts.length >= 5) {
      const shortID = `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`;
      return (
        <span
          className="correlation-id-compact"
          title={correlationID}
          onClick={handleCopy}
        >
          {shortID}
          <span className="cid-copy-hint">📋</span>
        </span>
      );
    }
  }

  return (
    <div className="correlation-id-display">
      <code className="cid-text" title="Click to copy">{correlationID}</code>
      <button
        className={`cid-copy-btn ${copied ? 'copied' : ''}`}
        onClick={handleCopy}
        title="Copy to clipboard"
      >
        {copied ? '✓ Copied' : '📋 Copy'}
      </button>
    </div>
  );
};

export default CorrelationIDDisplay;
