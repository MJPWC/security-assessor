import React, { useState, useEffect, useRef } from 'react';
import ExcelJS from 'exceljs';
import './OutputViewer.css';

function worksheetToRows(worksheet) {
  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    headers[column] = cell.text.trim();
  });

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    headers.forEach((header, column) => {
      if (header) item[header] = row.getCell(column).text;
    });
    if (Object.values(item).some(value => String(value).trim())) rows.push(item);
  });
  return rows;
}

const OutputViewer = ({
  outputs,
  agents,
  sessionId = null,
  onRegenerateDiagram = null,
  onGenerateDiagram = null,
  onGenerateEstimation = null,
  useCases = null,
  onExtractUseCases = null,
  onSaveUseCases = null,
  onGenerateUseCaseSequence = null,
  onGenerateMasterArchitecture = null,
  onGenerateNetworkTopology = null,
  awaitingInput = {},
  onDownloadDocument,
  onStartDocumentation,
  onDownloadRaml,
  onPublishRaml,
  onGenerateMuleCode,
  documentsByType = {},
  generatingDocType = null,
  docPendingByType = {},
  ramlApiTasks = [],
  ramlSelectedApiId = null,
  isRamlSelectionPending = false,
  onGenerateRamlForApi,
  ramlByApi = {},
  loadingApiIds = new Set(),
  muleCodeGenerated = new Set(),
  onError = null
}) => {
  const [activeTab, setActiveTab] = useState('general');
  const [copied, setCopied] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [expandedApiId, setExpandedApiId] = useState(null);
  const [expandedDocId, setExpandedDocId] = useState(null);
  const [apiFieldState, setApiFieldState] = useState({});
  const [downloadingDocType, setDownloadingDocType] = useState(null);
  const [ramlDownloadingApiId, setRamlDownloadingApiId] = useState(null);
  const [ramlPublishingApiId, setRamlPublishingApiId] = useState(null);
  const [ramlPublishedApiIds, setRamlPublishedApiIds] = useState(new Set());
  const [expandedOutputs, setExpandedOutputs] = useState(new Set());
  // ── Use-case driven diagram flow state ──────────────────────────────
  const [extractingUseCases, setExtractingUseCases] = useState(false);
  const [editingUseCases, setEditingUseCases] = useState(false);
  const [draftUseCases, setDraftUseCases] = useState([]);
  const [savingUseCases, setSavingUseCases] = useState(false);
  const [ucSeqLoading, setUcSeqLoading] = useState({}); // { [ucId]: bool }
  const [ucSeqError, setUcSeqError] = useState({});      // { [ucId]: string }
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterError, setMasterError] = useState(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkError, setNetworkError] = useState(null);

  const reportError = (error, title = 'Action failed') => {
    if (onError) {
      onError(error, title);
    }
  };

  const tabs = [
    { id: 'general', label: '💬 General Q&A', icon: '💬' },
    { id: 'architecture', label: '📐 Architecture', icon: '📐' },
    { id: 'diagram', label: '📊 Diagram', icon: '📊' },
    { id: 'estimation', label: '💰 Estimation', icon: '💰' },
    { id: 'raml', label: '📝 RAML', icon: '📝' },
    { id: 'document', label: '📄 Document', icon: '📄' }
  ];

  const getAgentStatus = (tabId) => {
    if (!agents) return null;
    const tabToAgentMap = {
      general: 'General',
      architecture: 'Architecture',
      diagram: 'Diagram',
      estimation: 'Estimation',
      raml: 'RAML',
      document: 'Documentation'
    };
    const agentName = tabToAgentMap[tabId];
    if (!agentName) return null;
    return agents[agentName]?.status || null;
  };

  const handleApiModeChange = (apiId, mode) => {
    setApiFieldState(prev => ({
      ...prev,
      [apiId]: {
        ...(prev[apiId] || {}),
        mode,
        uploadError: '',
        fieldDefinitions: mode === 'without-fields' ? [] : (prev[apiId]?.fieldDefinitions || []),
        fieldFileName: mode === 'without-fields' ? '' : (prev[apiId]?.fieldFileName || ''),
        isParsingFields: false
      }
    }));
  };

  const normalizeFieldRow = (row, index) => {
    const name = row['Field Name'] || row['fieldName'] || row['Field'] || row['Name'];
    const type = row['Type'] || row['Data Type'] || row['datatype'] || row['Type Name'];
    const description = row['Description'] || row['Details'] || row['Notes'];
    const required = row['Required'] || row['Mandatory'] || row['required'];
    const system = row['System'] || row['Source System'];

    return {
      id: `field-${index}-${Date.now()}`,
      name: (name || '').toString().trim() || `Field_${index + 1}`,
      type: (type || '').toString().trim() || 'string',
      description: (description || '').toString().trim(),
      required: typeof required === 'string' ? required.trim() : required,
      system: typeof system === 'string' ? system.trim() : system
    };
  };

  const handleFieldFileChange = async (apiId, event) => {
    const file = event.target.files?.[0];

    setApiFieldState(prev => ({
      ...prev,
      [apiId]: {
        ...(prev[apiId] || {}),
        uploadError: '',
        fieldDefinitions: [],
        fieldFileName: '',
        isParsingFields: false
      }
    }));

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setApiFieldState(prev => ({
        ...prev,
        [apiId]: {
          ...(prev[apiId] || {}),
          uploadError: 'Please upload an Excel workbook (.xlsx).',
          fieldDefinitions: [],
          fieldFileName: ''
        }
      }));
      return;
    }

    setApiFieldState(prev => ({
      ...prev,
      [apiId]: {
        ...(prev[apiId] || {}),
        fieldFileName: file.name,
        isParsingFields: true,
        uploadError: '',
        fieldDefinitions: []
      }
    }));

    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const firstSheet = workbook.worksheets[0];

      if (!firstSheet) {
        throw new Error('No worksheets found in the uploaded file.');
      }

      const rows = worksheetToRows(firstSheet);
      const normalized = rows.map(normalizeFieldRow).filter(field => field.name);

      if (!normalized.length) {
        throw new Error('No field rows detected. Please ensure the sheet has headers like "Field Name", "Type", "Description".');
      }

      setApiFieldState(prev => ({
        ...prev,
        [apiId]: {
          ...(prev[apiId] || {}),
          fieldDefinitions: normalized,
          isParsingFields: false,
          uploadError: ''
        }
      }));
    } catch (error) {
      setApiFieldState(prev => ({
        ...prev,
        [apiId]: {
          ...(prev[apiId] || {}),
          uploadError: error.message || 'Failed to parse the uploaded file. Please verify the template.',
          fieldDefinitions: [],
          isParsingFields: false
        }
      }));
    }
  };

  const handleGenerateForApi = (apiTask) => {
    if (!onGenerateRamlForApi || !apiTask) return;

    const state = apiFieldState[apiTask.id] || {};
    const mode = state.mode || 'without-fields';
    const includeFields = mode === 'with-fields';

    if (includeFields) {
      if (state.isParsingFields) {
        reportError({ message: 'Please wait until the Excel file finishes processing.' }, 'RAML field file still processing');
        return;
      }
      if (!state.fieldDefinitions || state.fieldDefinitions.length === 0) {
        reportError({ message: 'Upload an Excel file with field definitions to continue.' }, 'Field definitions required');
        return;
      }
    }

    onGenerateRamlForApi(apiTask, {
      includeFields,
      fieldDefinitions: includeFields ? state.fieldDefinitions : []
    });
  };

  // Use a ref to track the last processed RAML tasks to prevent unnecessary re-renders
  const lastProcessedTasksRef = useRef([]);
  
  // Update expanded API ID when ramlSelectedApiId changes
  useEffect(() => {
    if (ramlSelectedApiId) {
      setExpandedApiId(ramlSelectedApiId);
    }
  }, [ramlSelectedApiId]);
  
  // Debug effect to log RAML tasks changes
  useEffect(() => {
    if (JSON.stringify(ramlApiTasks) !== JSON.stringify(lastProcessedTasksRef.current)) {
      console.log('RAML Tasks Updated:', {
        previousCount: lastProcessedTasksRef.current.length,
        currentCount: ramlApiTasks.length,
        previousIds: lastProcessedTasksRef.current.map(t => t.id),
        currentIds: ramlApiTasks.map(t => t.id)
      });
      lastProcessedTasksRef.current = [...ramlApiTasks];
    }
  }, [ramlApiTasks]);

  // We don't toggle container styles by status to keep layout stable

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const toggleExpandedOutput = (id) => {
    setExpandedOutputs(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderFullTextBlock = (text, id, className = 'text-content') => {
    const value = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    const isExpanded = expandedOutputs.has(id);
    const isLong = value.length > 2500;

    return (
      <div className="full-response">
        <pre className={`${className} full-response-block ${isExpanded ? 'expanded' : ''}`}>
          {value}
        </pre>
        {isLong && (
          <div className="full-response-actions">
            <button
              type="button"
              className="show-full-btn"
              onClick={() => toggleExpandedOutput(id)}
            >
              {isExpanded ? 'Collapse response' : 'Show full response'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const tabToAgentMap = {
    general: 'General',
    architecture: 'Architecture',
    diagram: 'Diagram',
    estimation: 'Estimation',
    raml: 'RAML',
    document: 'Documentation'
  };

  const getAgentStateForTab = (tabId) => {
    const agentName = tabToAgentMap[tabId];
    return agentName ? agents?.[agentName] : null;
  };

  const renderStatusPlaceholder = (tabId, emptyMessage) => {
    const agentState = getAgentStateForTab(tabId);
    const status = agentState?.status;
    const message = agentState?.message;
    const isAwaiting = !!awaitingInput[tabId];
    const isActive =
      status === 'working' ||
      status === 'waiting' ||
      status === 'needs-input' ||
      status === 'blocked' ||
      status === 'error' ||
      isAwaiting;

    if (!isActive) {
      return (
        <div className="empty-output">
          <p>{emptyMessage}</p>
        </div>
      );
    }

    const statusLabel =
      status === 'error'
        ? 'Generation failed'
        : status === 'blocked'
          ? 'Waiting on required input'
          : status === 'waiting' || status === 'needs-input' || isAwaiting
            ? 'Waiting for your input'
            : 'Generating response';

    return (
      <div className={`agent-status-placeholder ${status || 'working'}`}>
        {status === 'error' || status === 'blocked' ? (
          <div className="agent-status-icon">!</div>
        ) : (
          <div className="agent-status-spinner" />
        )}
        <div className="agent-status-copy">
          <h4>{statusLabel}</h4>
          <p>{message || emptyMessage}</p>
        </div>
      </div>
    );
  };

  // Add this helper function inside the OutputViewer component, before the renderContent function
  const renderStructuredEstimation = (estimation) => {
    try {
      const data = typeof estimation === 'string' ? JSON.parse(estimation) : estimation;
      const rawEstimation = typeof estimation === 'string' ? estimation : JSON.stringify(estimation, null, 2);

      return (
        <div className="estimation-container">
          <h3>Project Estimation</h3>

          <div className="estimation-section">
            <h4>Breakdown</h4>
            {data.breakdown?.map((item, index) => (
              <div key={index} className="estimation-task">
                <div className="task-header">
                  <span className="task-name">{item.task}</span>
                  <span className={`complexity-badge ${item.complexity?.toLowerCase()}`}>
                    {item.complexity}
                  </span>
                  {item.tshirtSize && (
                    <span className="tshirt-size">Size: {item.tshirtSize}</span>
                  )}
                  {item.confidence && (
                    <span className={`confidence-badge ${item.confidence?.toLowerCase()}`}>
                      Confidence: {item.confidence}
                    </span>
                  )}
                </div>

                {item.subtasks?.length > 0 && (
                  <div className="subtasks">
                    {item.subtasks.map((subtask, sIndex) => (
                      <div key={sIndex} className="subtask">
                        <span className="subtask-name">{subtask.name}</span>
                        <span className="effort">
                          {subtask.hours} hours ({subtask.owner})
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {item.risks?.length > 0 && (
                  <div className="risks">
                    <h5>Risks:</h5>
                    {item.risks.map((risk, rIndex) => (
                      <div key={rIndex} className="risk">
                        <span className="risk-desc">{risk.description}</span>
                        <span className="risk-impact">Impact: {risk.impact}</span>
                        <span className="risk-prob">Probability: {risk.probability}</span>
                        <span className="risk-mitigation">Mitigation: {risk.mitigation}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.summary && (
            <div className="estimation-summary">
              <h4>Summary</h4>
              <div className="summary-grid">
                <div className="summary-item">
                  <span className="summary-label">Total Hours:</span>
                  <span className="summary-value">{data.summary.totalHours}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Total Days:</span>
                  <span className="summary-value">{data.summary.totalDays}</span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Timeline:</span>
                  <span className="summary-value">{data.summary.timelineWeeks} weeks</span>
                </div>
                {data.summary.team && (
                  <div className="summary-item team-summary">
                    <span className="summary-label">Team:</span>
                    <div className="team-members">
                      {Object.entries(data.summary.team).map(([role, count]) => (
                        <span key={role} className="team-member">
                          {count} {role}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {data.assumptions?.length > 0 && (
            <div className="assumptions">
              <h4>Assumptions</h4>
              <ul>
                {data.assumptions.map((assumption, index) => (
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </div>
          )}

          {data.riskAssessment && (
            <div className="risk-assessment">
              <h4>Risk Assessment</h4>
              <div className="risk-overview">
                Overall Risk: <span className={`risk-level ${data.riskAssessment.overallRisk?.toLowerCase()}`}>
                  {data.riskAssessment.overallRisk}
                </span>
              </div>
              {data.riskAssessment.keyRisks?.length > 0 && (
                <div className="key-risks">
                  <h5>Key Risks:</h5>
                  {data.riskAssessment.keyRisks.map((risk, index) => (
                    <div key={index} className="key-risk">
                      <div className="risk-header">
                        <span className="risk-desc">{risk.description}</span>
                        <span className={`risk-impact ${risk.impact?.toLowerCase()}`}>
                          Impact: {risk.impact}
                        </span>
                        <span className={`risk-probability ${risk.probability?.toLowerCase()}`}>
                          Probability: {risk.probability}
                        </span>
                      </div>
                      {risk.mitigation && (
                        <div className="risk-mitigation">
                          <strong>Mitigation:</strong> {risk.mitigation}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <details className="raw-output-details">
            <summary>View raw estimation response</summary>
            {renderFullTextBlock(rawEstimation, 'estimation-structured-raw')}
          </details>
        </div>
      );
    } catch (error) {
      console.error('Error rendering structured estimation:', error);
      return renderFullTextBlock(estimation, 'estimation-raw');
    }
  };

  const handleDownload = async () => {
    const current = outputs[activeTab];
    if (!onDownloadDocument || !current) return;

    setIsDownloading(true);
    try {
      await onDownloadDocument(current, activeTab);
    } catch (error) {
      console.error('Download failed:', error);
      reportError(error, 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDownloadForDocType = async (docTypeId) => {
    const content = documentsByType && documentsByType[docTypeId];
    if (!onDownloadDocument || !content) return;

    setDownloadingDocType(docTypeId);
    try {
      await onDownloadDocument(content, docTypeId);
    } catch (error) {
      console.error('Download failed:', error);
      reportError(error, 'Download failed');
    } finally {
      setDownloadingDocType(null);
    }
  };

  const handleDownloadRamlForApi = async (apiTask, apiRamlContent) => {
    if (!onDownloadRaml || !apiTask || !apiTask.id || !apiRamlContent) return;

    setRamlDownloadingApiId(apiTask.id);
    try {
      await onDownloadRaml(apiTask, apiRamlContent);
    } catch (error) {
      console.error('RAML download failed:', error);
      reportError(error, 'RAML download failed');
    } finally {
      setRamlDownloadingApiId(null);
    }
  };

  const handlePublishRamlForApi = async (apiTask, apiRamlContent) => {
    if (!onPublishRaml || !apiTask || !apiTask.id || !apiRamlContent) return;

    setRamlPublishingApiId(apiTask.id);
    try {
      const result = await onPublishRaml(apiTask, apiRamlContent);
      const isSuccess = !!(result && result.success === true);

      if (isSuccess) {
        // Mark this API as successfully published
        setRamlPublishedApiIds(prev => {
          const next = new Set(prev);
          next.add(apiTask.id);
          return next;
        });
      } else {
        // Ensure this API is not marked as published on explicit failure or missing result
        setRamlPublishedApiIds(prev => {
          if (!prev.has(apiTask.id)) return prev;
          const next = new Set(prev);
          next.delete(apiTask.id);
          return next;
        });
      }
    } catch (error) {
      console.error('RAML publish failed:', error);
      reportError(error, 'RAML publish failed');
      // Clear any published flag on hard error
      setRamlPublishedApiIds(prev => {
        if (!prev.has(apiTask.id)) return prev;
        const next = new Set(prev);
        next.delete(apiTask.id);
        return next;
      });
    } finally {
      setRamlPublishingApiId(null);
    }
  };

  const renderDocumentTab = () => {
    const docTypes = [
      { id: 'BRD', label: 'BRD', description: 'Business Requirements Document' },
      { id: 'HLD', label: 'HLD', description: 'High Level Design' },
      { id: 'WBS', label: 'WBS', description: 'Work Breakdown Structure' },
      { id: 'TDD', label: 'TDD', description: 'Technical Design Document' },
      { id: 'TEST_PLAN', label: 'Test Plan', description: 'Test Plan' }
    ];

    const hasRamlTopics =
      !!outputs.raml ||
      (ramlByApi && typeof ramlByApi === 'object' && Object.keys(ramlByApi).length > 0) ||
      (Array.isArray(ramlApiTasks) && ramlApiTasks.length > 0);
    const missingDocumentInputs = [
      !outputs.architecture ? 'architecture' : null,
      !outputs.estimation ? 'estimation' : null,
      !hasRamlTopics ? 'RAML topics' : null
    ].filter(Boolean);
    const hasContext = missingDocumentInputs.length === 0;
    const hasAnyDocs = documentsByType && Object.keys(documentsByType).length > 0;
    const blockedMessage = missingDocumentInputs.length
      ? `Waiting on required input: ${missingDocumentInputs.join(', ')}. Generate these before creating documents.`
      : '';

    return (
      <div className="output-content">
        <div className="output-header">
          <h3>📄 Documentation</h3>
        </div>

        {!hasContext && (
          renderStatusPlaceholder(
            'document',
            blockedMessage
          )
        )}

        <div className="doc-list">
          {docTypes.map(doc => {
              const content = documentsByType && documentsByType[doc.id];
              const isGenerated = !!content;
              const isExpanded = expandedDocId === doc.id;
              const isDownloadingThis = downloadingDocType === doc.id;
              const pendingFlag = docPendingByType && docPendingByType[doc.id];
              const isPending = !isGenerated && (pendingFlag || generatingDocType === doc.id);

              return (
                <div
                  key={doc.id}
                  className={`doc-item ${isGenerated ? 'generated' : 'pending'} ${isExpanded ? 'expanded' : ''}`}
                  style={{
                    border: '1px solid #e0e0e0',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    marginBottom: '8px',
                    backgroundColor: isGenerated ? '#f9fffb' : '#ffffff'
                  }}
                >
                  <div
                    className="doc-item-header"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '12px'
                    }}
                  >
                    <div className="doc-item-title" style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="doc-code" style={{ fontWeight: 600 }}>{doc.label}</span>
                      <span className="doc-description" style={{ fontSize: '0.85rem', color: '#555' }}>{doc.description}</span>
                    </div>
                    <div className="doc-item-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                      {isGenerated && (
                        <>
                          <button
                            onClick={() => handleCopy(content, `document-${doc.id}`)}
                            className="copy-btn"
                          >
                            {copied === `document-${doc.id}` ? '✓ Copied' : '📋 Copy'}
                          </button>
                          <button
                            onClick={() => handleDownloadForDocType(doc.id)}
                            className="download-btn"
                            disabled={isDownloadingThis}
                            style={{
                              padding: '6px 12px',
                              backgroundColor: '#4CAF50',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: isDownloadingThis ? 'not-allowed' : 'pointer',
                              opacity: isDownloadingThis ? 0.6 : 1
                            }}
                          >
                            {isDownloadingThis ? '⏳ Converting...' : '📥 Download Word'}
                          </button>
                        </>
                      )}
                      {!isGenerated && onStartDocumentation && (
                        <button
                          onClick={isPending || !hasContext ? undefined : () => onStartDocumentation(doc.id)}
                          disabled={isPending || !hasContext}
                          className="generate-doc-btn"
                          title={!hasContext ? blockedMessage : 'Generate document'}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: hasContext ? '#2196F3' : '#9aa4b2',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: isPending || !hasContext ? 'not-allowed' : 'pointer',
                            opacity: isPending || !hasContext ? 0.75 : 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                          }}
                        >
                          {isPending && <span className="doc-loading-spinner" />}
                          <span>{isPending ? 'Generating...' : hasContext ? 'Generate document' : 'Blocked'}</span>
                        </button>
                      )}
                      {isGenerated && (
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() => setExpandedDocId(prev => (prev === doc.id ? null : doc.id))}
                          style={{
                            padding: '4px 10px',
                            backgroundColor: '#f1f1f1',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                          }}
                        >
                          {isExpanded ? 'Hide' : 'View'}
                        </button>
                      )}
                    </div>
                  </div>
                  {isGenerated && isExpanded && (
                    <div className="doc-item-body" style={{ marginTop: '8px' }}>
                      {renderFullTextBlock(content, `document-${doc.id}-full`)}
                    </div>
                  )}
                </div>
              );
          })}
        </div>

        {hasContext && !hasAnyDocs && (
          <div style={{ marginTop: '12px' }}>
            {renderStatusPlaceholder(
              'document',
              'Select a document type above and click "Generate document" to create documentation.'
            )}
          </div>
        )}
      </div>
    );
  };

  const renderContent = () => {
    const content = outputs[activeTab];

    if (!content && activeTab !== 'general' && activeTab !== 'raml' && activeTab !== 'document' && activeTab !== 'diagram') {
      return renderStatusPlaceholder(
        activeTab,
        `No ${activeTab} generated yet. Start generation to see output here.`
      );
    }

    if (activeTab === 'general') {
      return (
        <div className="output-content">
          <div className="output-header">
            <h3>General Q&A Answer</h3>
            <div className="header-buttons">
              {content && (
                <button
                  onClick={() => handleCopy(content, 'general')}
                  className="copy-btn"
                >
                  {copied === 'general' ? '✓ Copied' : '📋 Copy'}
                </button>
              )}
            </div>
          </div>
          {content ? (
            <div className="markdown-content">
              {renderFullTextBlock(content, 'general-full')}
            </div>
          ) : (
            renderStatusPlaceholder('general', 'No answer yet. Ask a general question to see the answer here.')
          )}
        </div>
      );
    }

    if (activeTab === 'diagram') {
      const diagramData = outputs.diagramData;
      const hasUseCases = Array.isArray(useCases) && useCases.length > 0;
      const hasArchitecture = !!outputs.architecture;

      // Master / high-level architecture diagram URL (covers all use cases)
      const masterUrl = diagramData?.masterArchitecture || diagramData?.component || null;
      const masterOk = masterUrl && masterUrl.startsWith('https://');
      const networkUrl = diagramData?.networkTopology || null;
      const networkOk = networkUrl && networkUrl.startsWith('https://');

      // ── Handlers for the use-case driven flow ──────────────────────
      const handleExtract = async () => {
        if (!onExtractUseCases) return;
        setExtractingUseCases(true);
        try {
          await onExtractUseCases();
        } catch (_) { /* surfaced via alert in parent */ }
        finally { setExtractingUseCases(false); }
      };

      const startEdit = () => {
        setDraftUseCases((useCases || []).map(u => ({ ...u })));
        setEditingUseCases(true);
      };
      const cancelEdit = () => { setEditingUseCases(false); setDraftUseCases([]); };
      const changeDraft = (idx, field, value) => {
        setDraftUseCases(prev => prev.map((u, i) => (i === idx ? { ...u, [field]: value } : u)));
      };
      const addDraft = () => {
        setDraftUseCases(prev => [...prev, { id: `uc_new_${Date.now()}_${prev.length}`, name: '', description: '' }]);
      };
      const deleteDraft = (idx) => {
        setDraftUseCases(prev => prev.filter((_, i) => i !== idx));
      };
      const persistDraftUseCases = async () => {
        if (!onSaveUseCases) return;
        const cleaned = draftUseCases
          .map(u => ({ ...u, name: (u.name || '').trim(), description: (u.description || '').trim() }))
          .filter(u => u.name);
        return onSaveUseCases(cleaned);
      };
      const saveEdit = async () => {
        if (!onSaveUseCases) return;
        setSavingUseCases(true);
        try {
          await persistDraftUseCases();
          setEditingUseCases(false);
          setDraftUseCases([]);
        } catch (_) { /* surfaced via alert in parent */ }
        finally { setSavingUseCases(false); }
      };

      const genSeq = async (ucId) => {
        if (!onGenerateUseCaseSequence) return;
        setUcSeqError(prev => ({ ...prev, [ucId]: null }));
        setUcSeqLoading(prev => ({ ...prev, [ucId]: true }));
        try {
          await onGenerateUseCaseSequence(ucId);
        } catch (err) {
          setUcSeqError(prev => ({ ...prev, [ucId]: err?.response?.data?.error || err.message || 'Generation failed' }));
        } finally {
          setUcSeqLoading(prev => ({ ...prev, [ucId]: false }));
        }
      };

      const genMaster = async () => {
        if (!onGenerateMasterArchitecture) return;
        setMasterError(null);
        setMasterLoading(true);
        try {
          if (editingUseCases) {
            setSavingUseCases(true);
            await persistDraftUseCases();
            setEditingUseCases(false);
            setDraftUseCases([]);
          }
          await onGenerateMasterArchitecture();
        } catch (err) {
          setMasterError(err?.response?.data?.error || err.message || 'Generation failed');
        } finally {
          setSavingUseCases(false);
          setMasterLoading(false);
        }
      };

      const genNetworkTopology = async () => {
        if (!onGenerateNetworkTopology) return;
        setNetworkError(null);
        setNetworkLoading(true);
        try {
          if (editingUseCases) {
            setSavingUseCases(true);
            await persistDraftUseCases();
            setEditingUseCases(false);
            setDraftUseCases([]);
          }
          await onGenerateNetworkTopology();
        } catch (err) {
          setNetworkError(err?.response?.data?.error || err.message || 'Generation failed');
        } finally {
          setSavingUseCases(false);
          setNetworkLoading(false);
        }
      };

      return (
        <div className="output-content">
          <div className="output-header">
            <h3>Use Cases &amp; Diagrams</h3>
          </div>

          {/* No use cases extracted yet → Step 1 entry point */}
          {!hasUseCases && (
            <div className="diagram-container">
              {!hasArchitecture ? (
                renderStatusPlaceholder(
                  'diagram',
                  'Generate an architecture first, then extract use cases here to build diagrams.'
                )
              ) : (
                <div style={{ padding: '16px', backgroundColor: '#fff8f0', borderRadius: '8px', borderLeft: '4px solid #FF6B00' }}>
                  <p style={{ marginTop: 0, color: '#444' }}>
                    <strong>Step 1.</strong> Break the architecture into individual use cases. You can then edit them,
                    generate one sequence diagram per use case, and a combined master architecture diagram.
                  </p>
                  <button
                    onClick={handleExtract}
                    disabled={extractingUseCases || !onExtractUseCases}
                    style={{ padding: '10px 18px', backgroundColor: '#FF6B00', color: 'white', border: 'none', borderRadius: '6px', cursor: extractingUseCases ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: extractingUseCases ? 0.7 : 1 }}
                  >
                    {extractingUseCases ? '⏳ Extracting Use Cases…' : '🔍 Extract Use Cases'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Use cases exist → list + diagrams */}
          {hasUseCases && (
            <div className="diagram-container">
              {/* ── Use Case list ───────────────────────────────── */}
              <div className="drawio-section">
                <div className="drawio-section-header">
                  <h4>📋 Use Cases ({useCases.length})</h4>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {!editingUseCases ? (
                      <>
                        <button className="regen-btn" onClick={startEdit} title="Edit, add or delete use cases">✏️ Edit Use Cases</button>
                        <button className="regen-btn" onClick={handleExtract} disabled={extractingUseCases} title="Re-extract use cases from architecture">
                          {extractingUseCases ? <><span className="regen-spinner"/> Re-extracting…</> : <>🔄 Re-extract</>}
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="regen-btn" onClick={addDraft}>+ Add Use Case</button>
                        <button className="regen-btn" onClick={saveEdit} disabled={savingUseCases}>
                          {savingUseCases ? <><span className="regen-spinner"/> Saving…</> : <>💾 Save</>}
                        </button>
                        <button className="regen-btn" onClick={cancelEdit} disabled={savingUseCases}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>

                {/* View mode */}
                {!editingUseCases && (
                  <div className="usecase-list">
                    {useCases.map((uc) => {
                      const seqUrl = uc.sequenceDiagram;
                      const seqOk = seqUrl && seqUrl.startsWith('https://');
                      const loading = !!ucSeqLoading[uc.id];
                      return (
                        <div key={uc.id} style={{ border: '1px solid #e0e0e0', borderRadius: '8px', padding: '12px', marginBottom: '10px', background: '#fff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, color: '#222' }}>{uc.name}</div>
                              {uc.description && <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '2px' }}>{uc.description}</div>}
                            </div>
                            <button
                              className={`regen-btn ${loading ? 'regen-btn--loading' : ''}`}
                              onClick={() => genSeq(uc.id)}
                              disabled={loading}
                              title={seqOk ? 'Regenerate sequence diagram' : 'Generate sequence diagram'}
                            >
                              {loading ? <><span className="regen-spinner"/> Generating…</> : (seqOk ? '🔄 Regenerate Sequence' : '🔄 Generate Sequence')}
                            </button>
                          </div>
                          {ucSeqError[uc.id] && <p className="drawio-error-msg">⚠️ {ucSeqError[uc.id]}</p>}
                          {!loading && seqOk && (
                            <a href={seqUrl} target="_blank" rel="noopener noreferrer" className="drawio-open-btn" style={{ marginTop: '8px', display: 'inline-block' }}>
                              🔗 Open Sequence Diagram in draw.io
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Edit mode */}
                {editingUseCases && (
                  <div className="usecase-edit-list">
                    {draftUseCases.map((uc, idx) => (
                      <div key={uc.id || idx} style={{ border: '1px solid #e0e0e0', borderRadius: '8px', padding: '12px', marginBottom: '10px', background: '#fafafa' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                          <input
                            type="text"
                            value={uc.name}
                            placeholder="Use case name"
                            onChange={(e) => changeDraft(idx, 'name', e.target.value)}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: '4px', border: '1px solid #ccc', fontWeight: 600 }}
                          />
                          <button className="regen-btn" onClick={() => deleteDraft(idx)} title="Delete use case" style={{ color: '#e53935' }}>🗑️ Delete</button>
                        </div>
                        <textarea
                          value={uc.description}
                          placeholder="Short description (systems involved, flow)…"
                          onChange={(e) => changeDraft(idx, 'description', e.target.value)}
                          rows="2"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid #ccc', resize: 'vertical' }}
                        />
                      </div>
                    ))}
                    {draftUseCases.length === 0 && (
                      <p style={{ color: '#888' }}>No use cases. Click "+ Add Use Case" to create one.</p>
                    )}
                  </div>
                )}
              </div>

              <div className="architecture-views">
                <div className="architecture-views-header">
                  <div>
                    <h4>Architecture Views</h4>
                    <p>Generate logical and network views separately from the same saved use-case context.</p>
                  </div>
                </div>

                <div className="architecture-views-grid">
                  {/* ── Master / high-level architecture diagram ─────── */}
                  <div className="drawio-section architecture-view-section">
                    <div className="drawio-section-header">
                      <h4>🏗️ Master Architecture Diagram (all use cases)</h4>
                      <button
                        className={`regen-btn ${masterLoading ? 'regen-btn--loading' : ''}`}
                        onClick={genMaster}
                        disabled={masterLoading || savingUseCases}
                        title={masterOk ? 'Regenerate master architecture diagram' : 'Generate master architecture diagram'}
                      >
                        {masterLoading ? <><span className="regen-spinner"/> Generating…</> : (masterOk ? '🔄 Regenerate' : '🗺️ Generate Master HLD')}
                      </button>
                    </div>
                    {masterError && <p className="drawio-error-msg">⚠️ {masterError}</p>}
                    {masterLoading ? (
                      <div className="regen-placeholder">
                        <span className="regen-spinner regen-spinner--lg"/>
                        <span>Generating master architecture diagram…</span>
                      </div>
                    ) : masterOk ? (
                      <a href={masterUrl} target="_blank" rel="noopener noreferrer" className="drawio-open-btn">
                        🔗 Open Master Architecture Diagram in draw.io
                      </a>
                    ) : (
                      <p className="drawio-error-msg">Not generated yet — click "Generate Master HLD". Newly added use cases are included when you regenerate.</p>
                    )}
                  </div>

                  {/* ── Network topology diagram ─────────────────────── */}
                  <div className="drawio-section architecture-view-section">
                    <div className="drawio-section-header">
                      <h4>🌐 Network Topology Diagram</h4>
                      <button
                        className={`regen-btn ${networkLoading ? 'regen-btn--loading' : ''}`}
                        onClick={genNetworkTopology}
                        disabled={networkLoading || savingUseCases}
                        title={networkOk ? 'Regenerate network topology diagram' : 'Generate network topology diagram'}
                      >
                        {networkLoading ? <><span className="regen-spinner"/> Generating…</> : (networkOk ? '🔄 Regenerate Topology' : '🌐 Generate Topology')}
                      </button>
                    </div>
                    {networkError && <p className="drawio-error-msg">⚠️ {networkError}</p>}
                    {networkLoading ? (
                      <div className="regen-placeholder">
                        <span className="regen-spinner regen-spinner--lg"/>
                        <span>Generating network topology diagram…</span>
                      </div>
                    ) : networkOk ? (
                      <a href={networkUrl} target="_blank" rel="noopener noreferrer" className="drawio-open-btn">
                        🔗 Open Network Topology Diagram in draw.io
                      </a>
                    ) : (
                      <p className="drawio-error-msg">Not generated yet — click "Generate Topology". It will split external, boundary, internal, and backend zones and label protocol changes.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Estimation entry point ───────────────────────── */}
              {onGenerateEstimation && (
                <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#fff8f0', borderRadius: '8px', borderLeft: '4px solid #FF8F00', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ color: '#555', fontSize: '0.9rem' }}>Ready to estimate? User stories are pre-filled from your use cases.</span>
                  <button
                    onClick={onGenerateEstimation}
                    disabled={editingUseCases}
                    style={{ padding: '8px 16px', backgroundColor: '#FF8F00', color: 'white', border: 'none', borderRadius: '6px', cursor: editingUseCases ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: editingUseCases ? 0.6 : 1 }}
                  >
                    💰 Generate Estimation
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }
    if (activeTab === 'raml') {
      // Create a map to store the most recent version of each task
      const taskMap = new Map();
      
      // Process tasks in reverse order to keep the most recent version
      [...(Array.isArray(ramlApiTasks) ? ramlApiTasks : [])].reverse().forEach(task => {
        if (task && typeof task === 'object' && task.id && !taskMap.has(task.id)) {
          taskMap.set(task.id, {
            id: String(task.id),
            name: task.name || `API-${task.id.substring(0, 6)}`,
            description: task.description || ''
          });
        }
      });
      
      const effectiveTasks = Array.from(taskMap.values());
      const hasTasks = effectiveTasks.length > 0;

      return (
        <div className="output-content">
          <div className="output-header">
            <h3>RAML Specification</h3>
            <div className="header-buttons">
              {content && (
                <button
                  onClick={() => handleCopy(content, 'raml')}
                  className="copy-btn"
                >
                  {copied === 'raml' ? '✓ Copied' : '📋 Copy'}
                </button>
              )}
            </div>
          </div>

          

          {!hasTasks && renderStatusPlaceholder(
            'raml',
            'No RAML APIs are ready yet. Generate estimation first, then generate RAML for each API.'
          )}

          {hasTasks && (
            <div className="raml-api-list-container">
              <h4 className="raml-api-list-title">APIs from Estimation</h4>
              <div className="raml-api-list">
                {effectiveTasks.map(task => {
                  if (!task || !task.id) return null; // Skip invalid tasks
                  // Use the deduplicated task from our map
                  const taskId = String(task.id); // Ensure taskId is a string
                  const isLoading = loadingApiIds.has(taskId);
                  const apiRamlContent = ramlByApi[taskId] || (taskId === ramlSelectedApiId ? content : null);
                  const isGenerated = !!apiRamlContent && !isLoading;
                  const isExpanded = expandedApiId === taskId;
                  
                  // Debug log for task rendering
                  console.log('Rendering RAML task:', {
                    id: task.id,
                    name: task.name,
                    isGenerated,
                    isLoading,
                    hasRaml: !!ramlByApi[task.id],
                    isSelected: task.id === ramlSelectedApiId
                  });
                  const state = apiFieldState[task.id] || {};
                  const mode = state.mode || 'without-fields';
                  const isWithFields = mode === 'with-fields';
                  const isPendingForThisApi = isRamlSelectionPending && task.id === ramlSelectedApiId;
                  const isPublished = ramlPublishedApiIds.has(task.id);

                  return (
                    <div
                      key={taskId}
                      className={`raml-api-item ${isLoading ? 'loading' : isGenerated ? 'generated' : 'pending'} ${isExpanded ? 'expanded' : ''}`}
                    >
                      <button
                        type="button"
                        className="raml-api-header"
                        onClick={() => setExpandedApiId(prev => (prev === taskId ? null : taskId))}
                      >
                        <div className="raml-api-header-main">
                          <span className="raml-api-name">{task.name || 'Unnamed API'}</span>
                          {task.description && (
                            <span className="raml-api-description">{task.description}</span>
                          )}
                        </div>
                        <div className="raml-api-header-status">
                          {isLoading ? (
                            <span className="raml-api-badge loading-badge">Generating...</span>
                          ) : isGenerated ? (
                            (onDownloadRaml || onPublishRaml) ? (
                              <div className="raml-api-generated-actions">
                                {onDownloadRaml && (
                                  <button
                                    type="button"
                                    className="raml-action-btn download"
                                    disabled={ramlDownloadingApiId === task.id}
                                    onClick={() => handleDownloadRamlForApi(task, apiRamlContent)}
                                  >
                                    {ramlDownloadingApiId === task.id && (
                                      <span className="doc-loading-spinner" />
                                    )}
                                    <span>{ramlDownloadingApiId === task.id ? 'Downloading...' : 'Download RAML ZIP'}</span>
                                  </button>
                                )}
                                {onPublishRaml && (
                                  <button
                                    type="button"
                                    className="raml-action-btn publish"
                                    disabled={isPublished || ramlPublishingApiId === task.id}
                                    onClick={() => handlePublishRamlForApi(task, apiRamlContent)}
                                  >
                                    {ramlPublishingApiId === task.id && (
                                      <span className="doc-loading-spinner" />
                                    )}
                                    <span>
                                      {ramlPublishingApiId === task.id
                                        ? 'Publishing...'
                                        : isPublished
                                          ? 'Published'
                                          : 'Publish to Design Center'}
                                    </span>
                                  </button>
                                )}

                              </div>
                            ) : null
                          ) : (
                            <span className="raml-api-badge pending-badge">Pending</span>
                          )}
                          <span className="raml-api-arrow">{isExpanded ? '▾' : '▸'}</span>
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="raml-api-body">
                          {isLoading ? (
                            <div className="raml-api-loading">
                              <div className="loading-spinner"></div>
                              <p>Generating RAML for {task.name}...</p>
                            </div>
                          ) : isGenerated && apiRamlContent ? (
                            <div className="raml-api-generated-content">
                              {renderFullTextBlock(apiRamlContent, `raml-${taskId}-full`, 'code-block raml-block')}
                            </div>
                          ) : (
                            <div className="raml-api-options">
                              <div className="raml-api-question">How would you like to generate RAML for this API?</div>
                              <div className="raml-api-modes">
                                <label className={`raml-radio-option ${mode === 'without-fields' ? 'selected' : ''}`}>
                                  <input
                                    type="radio"
                                    name={`raml-mode-${task.id}`}
                                    value="without-fields"
                                    checked={mode === 'without-fields'}
                                    onChange={() => handleApiModeChange(task.id, 'without-fields')}
                                  />
                                  <div>
                                    <span className="raml-radio-title">Without Fields</span>
                                    <p className="raml-radio-description">Generate high-level RAML without explicit request/response schemas.</p>
                                  </div>
                                </label>

                                <label className={`raml-radio-option ${mode === 'with-fields' ? 'selected' : ''}`}>
                                  <input
                                    type="radio"
                                    name={`raml-mode-${task.id}`}
                                    value="with-fields"
                                    checked={mode === 'with-fields'}
                                    onChange={() => handleApiModeChange(task.id, 'with-fields')}
                                  />
                                  <div>
                                    <span className="raml-radio-title">With Fields</span>
                                    <p className="raml-radio-description">Use an Excel sheet to include detailed field definitions in the RAML.</p>
                                  </div>
                                </label>
                              </div>

                              {isWithFields && (
                                <div className="raml-fields-upload">
                                  <label className="raml-upload-label">
                                    <span>Upload field dictionary (.xlsx)</span>
                                    <input
                                      type="file"
                                      accept=".xlsx"
                                      onChange={(e) => handleFieldFileChange(task.id, e)}
                                      disabled={state.isParsingFields}
                                    />
                                  </label>
                                  <div className="raml-upload-status">
                                    {state.isParsingFields && <span>Processing spreadsheet...</span>}
                                    {!state.isParsingFields && state.fieldFileName && (
                                      <span>Loaded: {state.fieldFileName} ({state.fieldDefinitions?.length || 0} fields)</span>
                                    )}
                                  </div>
                                  {state.uploadError && (
                                    <div className="raml-selection-error">{state.uploadError}</div>
                                  )}
                                  {state.fieldDefinitions && state.fieldDefinitions.length > 0 && !state.uploadError && (
                                    <div className="raml-fields-summary">
                                      <p><strong>{state.fieldDefinitions.length}</strong> field definitions detected and ready to use.</p>
                                      <p className="raml-fields-summary-note">Exact details won't be displayed here, but will be applied to the RAML output.</p>
                                    </div>
                                  )}
                                </div>
                              )}

                              <div className="raml-api-actions">
                                <button
                                  type="button"
                                  className="raml-generate-btn"
                                  disabled={isPendingForThisApi}
                                  onClick={() => handleGenerateForApi(task)}
                                >
                                  {isPendingForThisApi ? 'Waiting for RAML generation...' : `Generate RAML${isWithFields ? ' with fields' : ''}`}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeTab === 'estimation') {
      try {
        const contentData = typeof content === 'string' ? JSON.parse(content) : content;
        return (
          <div className="output-content">
            <div className="output-header">
              <h3>Estimation</h3>
              <button
                onClick={() => handleCopy(JSON.stringify(contentData, null, 2), 'estimation')}
                className="copy-btn"
              >
                {copied === 'estimation' ? '✓ Copied' : '📋 Copy'}
              </button>
            </div>
            {renderStructuredEstimation(contentData)}
          </div>
        );
      } catch (e) {
        // Fallback to default display if parsing fails
        return (
          <div className="output-content">
            <div className="output-header">
              <h3>Estimation</h3>
              <button
                onClick={() => handleCopy(content, 'estimation')}
                className="copy-btn"
              >
                {copied === 'estimation' ? '✓ Copied' : '📋 Copy'}
              </button>
            </div>
            <div className="markdown-content">
              {renderFullTextBlock(content, 'estimation-raw-full')}
            </div>
          </div>
        );
      }
    }

    if (activeTab === 'document') {
      return renderDocumentTab();
    }

    return (
      <div className="output-content">
        <div className="output-header">
          <div className="output-title-row">
            <h3>{tabs.find(t => t.id === activeTab)?.label}</h3>
            {(activeTab === 'architecture' || activeTab === 'estimation') &&
              getAgentStatus(activeTab) === 'working' && (
              <span className="streaming-indicator">
                <span className="streaming-indicator-dot" />
                Generating
              </span>
            )}
          </div>
          <div className="header-buttons">
            {activeTab === 'document' && content && onDownloadDocument && (
              <button
                onClick={handleDownload}
                className="download-btn"
                disabled={isDownloading}
                style={{
                  marginRight: '8px',
                  padding: '6px 12px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isDownloading ? 'not-allowed' : 'pointer',
                  opacity: isDownloading ? 0.6 : 1
                }}
              >
                {isDownloading ? '⏳ Converting...' : '📥 Download Word'}
              </button>
            )}
            <button
              onClick={() => handleCopy(content, activeTab)}
              className="copy-btn"
            >
              {copied === activeTab ? '✓ Copied' : '📋 Copy'}
            </button>
          </div>
        </div>
        {activeTab === 'architecture' && onGenerateDiagram && (
          <div style={{ margin: '12px 0', padding: '12px', backgroundColor: '#fff8f0', borderRadius: '8px', borderLeft: '4px solid #FF6B00', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ color: '#555', fontSize: '0.9rem' }}>Architecture is ready.</span>
            <button
              onClick={onGenerateDiagram}
              style={{ padding: '8px 16px', backgroundColor: '#FF6B00', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
            >
              📊 Generate Diagram
            </button>
          </div>
        )}
        <div className="markdown-content">
          {renderFullTextBlock(content, `${activeTab}-full`)}
        </div>
      </div>
    );
  };

  return (
    <div className="output-viewer">
      <div className="output-tabs">
        {tabs.map(tab => {
          const status = getAgentStatus(tab.id);
          let hasContent = !!outputs[tab.id];
          let isTabCompleted = status === 'completed' || hasContent;
          let isTabWorking = status === 'working';
          const isTabAwaiting = !!awaitingInput[tab.id];

          if ((tab.id === 'architecture' || tab.id === 'estimation') && isTabWorking) {
            isTabCompleted = false;
          }

          // RAML tab: only show processing when RAML generation is actually running
          // for one or more APIs. As soon as APIs are extracted or any RAML exists,
          // the tab should show as completed (green tick).
          if (tab.id === 'raml') {
            const hasRamlTasks = Array.isArray(ramlApiTasks) && ramlApiTasks.length > 0;
            const hasRamlByApi =
              ramlByApi &&
              typeof ramlByApi === 'object' &&
              Object.keys(ramlByApi).length > 0;
            const isAnyRamlLoading =
              loadingApiIds instanceof Set ? loadingApiIds.size > 0 : false;

            hasContent = !!outputs.raml || hasRamlTasks || hasRamlByApi;
            isTabCompleted = hasContent;
            isTabWorking = isAnyRamlLoading || !!isRamlSelectionPending;
          }

          // Documentation tab: only show processing while a document is actually
          // being generated. Once any document content exists, show the green tick.
          if (tab.id === 'document') {
            const hasDocsByType =
              documentsByType &&
              typeof documentsByType === 'object' &&
              Object.keys(documentsByType).length > 0;
            const hasDocOutput = !!outputs.document;
            const isAnyDocPending =
              docPendingByType &&
              typeof docPendingByType === 'object' &&
              Object.values(docPendingByType).some(Boolean);

            hasContent = hasDocOutput || hasDocsByType;
            isTabCompleted = hasContent;
            isTabWorking = !!generatingDocType || isAnyDocPending;
          }

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''} ${isTabCompleted ? 'has-content' : ''} ${isTabWorking ? 'working' : ''} ${isTabAwaiting ? 'awaiting' : ''}`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label.split(' ')[1]}</span>
              {isTabWorking && !isTabCompleted && (
                <span className="tab-dot tab-dot-working" />
              )}
              {isTabAwaiting && !isTabWorking && !isTabCompleted && (
                <span className="tab-dot tab-dot-awaiting" />
              )}
              {isTabCompleted && <span className="checkmark">✓</span>}
            </button>
          );
        })}
      </div>
      <div className={`output-panel`}>
        {renderContent()}
      </div>
    </div>
  );
};

export default OutputViewer;
