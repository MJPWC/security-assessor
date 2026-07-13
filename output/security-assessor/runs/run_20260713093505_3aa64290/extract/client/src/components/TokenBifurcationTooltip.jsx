import React, { useState } from 'react';
import './TokenBifurcationTooltip.css';

/**
 * TokenBifurcationTooltip Component
 * Shows detailed token breakdown by category in a tooltip/popup
 */
const TokenBifurcationTooltip = ({ tokenData = {} }) => {
  const [isOpen, setIsOpen] = useState(false);

  // Calculate totals and percentages
  const entries = Object.entries(tokenData).filter(([_, value]) => value > 0);
  const total = entries.reduce((sum, [_, value]) => sum + value, 0);

  if (total === 0) {
    return <span className="tbt-empty">No data</span>;
  }

  const categoryColors = {
    'General': '#6366F1',
    'Architecture': '#3B82F6',
    'Diagram': '#8B5CF6',
    'Estimation': '#EC4899',
    'RAML': '#F59E0B',
    'Documentation': '#10B981',
  };

  return (
    <div className="token-bifurcation-tooltip">
      <button
        className="tbt-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title="View token breakdown"
      >
        📊 {total.toLocaleString()}
        <span className="tbt-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="tbt-popup">
          <div className="tbt-header">Token Breakdown</div>
          <div className="tbt-content">
            {entries.map(([category, value]) => {
              const percentage = ((value / total) * 100).toFixed(1);
              const color = categoryColors[category] || '#6366F1';
              return (
                <div key={category} className="tbt-row">
                  <div className="tbt-label">
                    <span
                      className="tbt-color"
                      style={{ backgroundColor: color }}
                    />
                    {category}
                  </div>
                  <div className="tbt-value">
                    <span className="tbt-count">{value.toLocaleString()}</span>
                    <span className="tbt-percent">({percentage}%)</span>
                  </div>
                </div>
              );
            })}
            <div className="tbt-total">
              <div className="tbt-label">Total</div>
              <div className="tbt-value">
                <span className="tbt-count">{total.toLocaleString()}</span>
              </div>
            </div>
          </div>
          <button
            className="tbt-close"
            onClick={() => setIsOpen(false)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};

export default TokenBifurcationTooltip;
