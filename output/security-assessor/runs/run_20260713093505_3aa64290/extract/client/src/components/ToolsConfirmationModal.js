import React, { useState, useEffect } from 'react';
import './ToolsConfirmationModal.css';

const ToolsConfirmationModal = ({ selectedApproach, approaches, onSubmit, onClose, isProcessing = false }) => {
  const [tools, setTools] = useState({
    source: '',
    target: '',
    middleware: '',
    externalApps: '',
    additionalTools: ''
  });

  // Extract tools/software information from the selected approach
  useEffect(() => {
    if (selectedApproach && approaches) {
      const approach = approaches.find(a => a.number === selectedApproach);
      if (approach) {
        const description = approach.description || approach.fullText || '';
        const fullText = approach.fullText || description;
        
        // Extract source systems (SAP, Salesforce, Workday, etc.)
        const sourcePatterns = [
          /source[:\s]+([A-Za-z0-9\s,]+)/i,
          /from[:\s]+([A-Za-z0-9\s,]+)/i,
          /(?:source|origin|start)[:\s]*([A-Za-z0-9\s,]+)/i
        ];
        let extractedSource = '';
        for (const pattern of sourcePatterns) {
          const match = fullText.match(pattern);
          if (match) {
            extractedSource = match[1].trim();
            break;
          }
        }
        
        // Common source systems
        const commonSources = ['SAP', 'Salesforce', 'Workday', 'Oracle', 'ServiceNow', 'Dynamics', 'NetSuite', 'Shopify', 'Magento'];
        if (!extractedSource) {
          for (const source of commonSources) {
            if (fullText.match(new RegExp(source, 'i'))) {
              extractedSource = source;
              break;
            }
          }
        }

        // Extract target systems
        const targetPatterns = [
          /target[:\s]+([A-Za-z0-9\s,]+)/i,
          /to[:\s]+([A-Za-z0-9\s,]+)/i,
          /(?:target|destination|end)[:\s]*([A-Za-z0-9\s,]+)/i
        ];
        let extractedTarget = '';
        for (const pattern of targetPatterns) {
          const match = fullText.match(pattern);
          if (match) {
            extractedTarget = match[1].trim();
            break;
          }
        }
        
        // Common target systems
        const commonTargets = ['SAP', 'Salesforce', 'Workday', 'Oracle', 'ServiceNow', 'Dynamics', 'NetSuite', 'Shopify', 'Magento'];
        if (!extractedTarget) {
          for (const target of commonTargets) {
            if (fullText.match(new RegExp(target, 'i')) && target !== extractedSource) {
              extractedTarget = target;
              break;
            }
          }
        }

        // Extract middleware (MQ, Kafka, AMQ, etc.)
        const middlewarePatterns = [
          /(?:using|via|with)[:\s]+(?:message[:\s]+queue|mq|kafka|amq|rabbitmq|activemq|ibm[:\s]+mq)/i,
          /(?:message[:\s]+queue|mq|kafka|amq|rabbitmq|activemq|ibm[:\s]+mq)/i
        ];
        let extractedMiddleware = '';
        for (const pattern of middlewarePatterns) {
          const match = fullText.match(pattern);
          if (match) {
            const matchText = match[0].toLowerCase();
            if (matchText.includes('kafka')) extractedMiddleware = 'Kafka';
            else if (matchText.includes('amq') || matchText.includes('activemq')) extractedMiddleware = 'AMQ';
            else if (matchText.includes('mq') || matchText.includes('message queue')) extractedMiddleware = 'MQ';
            else if (matchText.includes('rabbitmq')) extractedMiddleware = 'RabbitMQ';
            else if (matchText.includes('ibm')) extractedMiddleware = 'IBM MQ';
            break;
          }
        }

        // Check for two-way integration
        const isTwoWay = /two[-\s]?way|bi[-\s]?directional|bidirectional/i.test(fullText);
        if (isTwoWay && extractedSource && extractedTarget) {
          // For two-way, show both as source and target
          setTools(prev => ({
            ...prev,
            source: extractedSource,
            target: extractedTarget,
            middleware: extractedMiddleware
          }));
        } else {
          setTools(prev => ({
            ...prev,
            source: extractedSource,
            target: extractedTarget,
            middleware: extractedMiddleware
          }));
        }

        // Extract external applications
        const externalPatterns = [
          /external[:\s]+(?:application|app|system|software)[:\s]*([A-Za-z0-9\s,]+)/i,
          /third[-\s]?party[:\s]+(?:application|app|system|software)[:\s]*([A-Za-z0-9\s,]+)/i
        ];
        let extractedExternal = '';
        for (const pattern of externalPatterns) {
          const match = fullText.match(pattern);
          if (match) {
            extractedExternal = match[1].trim();
            break;
          }
        }
        
        if (extractedExternal) {
          setTools(prev => ({
            ...prev,
            externalApps: extractedExternal
          }));
        }
      }
    }
  }, [selectedApproach, approaches]);

  const handleToolChange = (field, value) => {
    setTools(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = () => {
    onSubmit(tools);
  };

  return (
    <div className="tools-confirmation-overlay">
      <div className="tools-confirmation-modal">
        <div className="tools-confirmation-header">
          <h2>🔧 Tools & Software Confirmation</h2>
          <button className="close-btn" onClick={onClose} disabled={isProcessing}>×</button>
        </div>

        <div className="tools-confirmation-content">
          <p className="tools-description">
            Please review and confirm the tools, software, and applications that will be used in this integration.
            You can edit any of the fields below.
          </p>

          <div className="tools-form">
            <div className="tool-field">
              <label htmlFor="source-tool">
                <strong>Source System:</strong>
              </label>
              <input
                id="source-tool"
                type="text"
                value={tools.source}
                onChange={(e) => handleToolChange('source', e.target.value)}
                placeholder="e.g., SAP, Salesforce, Workday"
                disabled={isProcessing}
              />
            </div>

            <div className="tool-field">
              <label htmlFor="target-tool">
                <strong>Target System:</strong>
              </label>
              <input
                id="target-tool"
                type="text"
                value={tools.target}
                onChange={(e) => handleToolChange('target', e.target.value)}
                placeholder="e.g., Salesforce, SAP, Workday"
                disabled={isProcessing}
              />
            </div>

            <div className="tool-field">
              <label htmlFor="middleware-tool">
                <strong>Message Queue:</strong>
              </label>
              <input
                id="middleware-tool"
                type="text"
                value={tools.middleware}
                onChange={(e) => handleToolChange('middleware', e.target.value)}
                placeholder="e.g., Kafka, AMQ, MQ, RabbitMQ"
                disabled={isProcessing}
              />
            </div>

            <div className="tool-field">
              <label htmlFor="external-apps-tool">
                <strong>External Applications/Software:</strong>
              </label>
              <input
                id="external-apps-tool"
                type="text"
                value={tools.externalApps}
                onChange={(e) => handleToolChange('externalApps', e.target.value)}
                placeholder="e.g., External APIs, Third-party services"
                disabled={isProcessing}
              />
            </div>

            <div className="tool-field">
              <label htmlFor="additional-tools">
                <strong>Additional Tools/Applications (Optional):</strong>
              </label>
              <textarea
                id="additional-tools"
                value={tools.additionalTools}
                onChange={(e) => handleToolChange('additionalTools', e.target.value)}
                placeholder="Enter any other tools, applications, or software that need to be integrated..."
                rows="3"
                disabled={isProcessing}
              />
            </div>
          </div>

          <div className="tools-actions">
            <button
              onClick={handleSubmit}
              disabled={isProcessing}
              className="confirm-btn"
            >
              {isProcessing ? 'Processing...' : 'Confirm & Generate Architecture'}
            </button>
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ToolsConfirmationModal;
