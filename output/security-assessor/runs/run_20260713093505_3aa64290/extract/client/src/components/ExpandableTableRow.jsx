import React, { useState } from 'react';
import './ExpandableTableRow.css';
import TokenBifurcationTooltip from './TokenBifurcationTooltip.jsx';

/**
 * ExpandableTableRow - Table row that expands to show token bifurcation details
 * 
 * Props:
 * - entry: The token usage entry data
 * - children: Table cells to display in the row
 * - idx: Row index for key
 */
const ExpandableTableRow = ({ entry, idx, children }) => {
  const [expanded, setExpanded] = useState(false);

  // Sample bifurcation breakdown (would come from backend in real scenario)
  const tokenBreakdown = {
    [entry.Token_Category || 'General']: {
      prompt: entry.Prompt_Tokens,
      completion: entry.Completion_Tokens,
      total: entry.Total_Tokens
    }
  };

  // Calculate percentages for visualization
  const totalTokens = entry.Total_Tokens || 1;
  const promptPercent = ((entry.Prompt_Tokens || 0) / totalTokens * 100).toFixed(1);
  const completionPercent = ((entry.Completion_Tokens || 0) / totalTokens * 100).toFixed(1);

  return (
    <>
      <tr 
        className={`expandable-row status-${entry.Status} ${expanded ? 'expanded' : ''}`}
        key={`row-${idx}`}
      >
        <td className="expander-col">
          <button
            className="expand-btn"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse row' : 'Expand row'}
          >
            {expanded ? '▼' : '▶'}
          </button>
        </td>
        {children}
      </tr>

      {expanded && (
        <tr className="expanded-content-row" key={`expanded-${idx}`}>
          <td colSpan="10" className="expanded-content">
            <div className="expansion-details">
              <div className="detail-section">
                <h4>📊 Token Breakdown</h4>
                <div className="token-breakdown">
                  <div className="token-chart">
                    <div className="token-bars">
                      <div className="token-bar prompt-bar">
                        <div 
                          className="token-segment prompt-segment"
                          style={{ width: `${promptPercent}%` }}
                        ></div>
                        <span className="bar-label">Prompt</span>
                      </div>
                      <div className="token-bar completion-bar">
                        <div 
                          className="token-segment completion-segment"
                          style={{ width: `${completionPercent}%` }}
                        ></div>
                        <span className="bar-label">Completion</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="token-stats">
                    <div className="stat-item">
                      <span className="stat-label">Prompt Tokens</span>
                      <span className="stat-value">{entry.Prompt_Tokens}</span>
                      <span className="stat-percent">({promptPercent}%)</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">Completion Tokens</span>
                      <span className="stat-value">{entry.Completion_Tokens}</span>
                      <span className="stat-percent">({completionPercent}%)</span>
                    </div>
                    <div className="stat-item total">
                      <span className="stat-label">Total Tokens</span>
                      <span className="stat-value">{entry.Total_Tokens}</span>
                      <span className="stat-percent">(100%)</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h4>🔤 Request Details</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Category:</span>
                    <span className="detail-value">{entry.Token_Category || 'General'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Instruction Length:</span>
                    <span className="detail-value">{entry.User_Instruction_Length || 'N/A'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Model:</span>
                    <span className="detail-value">{entry.Model_Name}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Provider:</span>
                    <span className="detail-value">{entry.LLM_Provider}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Correlation ID:</span>
                    <span className="detail-value mono">{entry.Correlation_ID || 'N/A'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Timestamp:</span>
                    <span className="detail-value">{entry['Timestamp (IST)']}</span>
                  </div>
                </div>
              </div>

              {entry.Error_Message && (
                <div className="detail-section error-details">
                  <h4>❌ Error Information</h4>
                  <p className="error-message">{entry.Error_Message}</p>
                </div>
              )}

              <div className="detail-section">
                <h4>💡 Token Bifurcation Tooltip</h4>
                <div className="tooltip-preview">
                  <TokenBifurcationTooltip 
                    category={entry.Token_Category || 'General'}
                    promptTokens={entry.Prompt_Tokens}
                    completionTokens={entry.Completion_Tokens}
                    totalTokens={entry.Total_Tokens}
                  />
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

export default ExpandableTableRow;
