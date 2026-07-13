import React from 'react';
import './AgentCard.css';

const AgentCard = ({ agent, data }) => {
  const { status, message, data: agentData } = data || { status: 'idle', message: '' };

  const getStatusIcon = () => {
    switch (status) {
      case 'working':
        return '⚙️';
      case 'completed':
        return '✅';
      case 'error':
        return '❌';
      default:
        return '⏸️';
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'working':
        return '#ffa726';
      case 'completed':
        return '#66bb6a';
      case 'error':
        return '#ef5350';
      default:
        return '#9e9e9e';
    }
  };

  return (
    <div className="agent-card" style={{ borderColor: getStatusColor() }}>
      <div className="agent-header">
        <span className="agent-icon">{getStatusIcon()}</span>
        <h3>{agent}</h3>
        <span className="status-badge" style={{ backgroundColor: getStatusColor() }}>
          {status}
        </span>
      </div>
      <div className="agent-body">
        <p className="agent-message">{message || 'Waiting...'}</p>
        {agentData && (
          <div className="agent-data-preview">
            <small>{agentData.length} characters generated</small>
          </div>
        )}
      </div>
      {status === 'working' && (
        <div className="loading-bar">
          <div className="loading-progress"></div>
        </div>
      )}
    </div>
  );
};

export default AgentCard;

