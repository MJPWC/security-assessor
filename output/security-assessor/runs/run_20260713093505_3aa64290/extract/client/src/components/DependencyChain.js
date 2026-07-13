import React from 'react';
import './DependencyChain.css';

const DependencyChain = ({ agents }) => {
  const steps = [
    { name: 'Architecture', icon: '📐', dependsOn: [] },
    { name: 'Diagram', icon: '📊', dependsOn: ['Architecture'] },
    { name: 'Estimation', icon: '💰', dependsOn: ['Architecture', 'Diagram'] },
    { name: 'RAML', icon: '📝', dependsOn: ['Architecture', 'Diagram', 'Estimation'] },
    { name: 'Documentation', icon: '📄', dependsOn: ['Architecture', 'Diagram', 'Estimation', 'RAML'] }
  ];

  const getStatus = (agentName) => {
    return agents[agentName]?.status || 'idle';
  };

  const isCompleted = (status) => status === 'completed';
  const isWorking = (status) => status === 'working';

  return (
    <div className="dependency-chain">
      <h2>🔗 Dependency Chain</h2>
      <div className="chain-container">
        {steps.map((step, index) => {
          const status = getStatus(step.name);
          const completed = isCompleted(status);
          const working = isWorking(status);
          
          return (
            <React.Fragment key={step.name}>
              <div className={`chain-step ${completed ? 'completed' : ''} ${working ? 'working' : ''}`}>
                <div className="step-icon">{step.icon}</div>
                <div className="step-name">{step.name}</div>
                <div className="step-status">{status}</div>
                {step.dependsOn.length > 0 && (
                  <div className="step-deps">
                    <small>Depends on: {step.dependsOn.join(', ')}</small>
                  </div>
                )}
              </div>
              {index < steps.length - 1 && (
                <div className={`chain-arrow ${completed ? 'active' : ''}`}>
                  ↓
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default DependencyChain;

