// RamlAgentModal.js
import React, { useState, useEffect } from 'react';
import ExcelJS from 'exceljs';
import './RamlAgentModal.css';

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

const RamlAgentModal = ({ onClose, socket, sessionId, isOpen, onApiSelected }) => {
  const [tasks, setTasks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiName, setApiName] = useState('MuleSoftAPI');
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [selectionError, setSelectionError] = useState('');
  const [ramlMode, setRamlMode] = useState('without-fields');
  const [fieldFileName, setFieldFileName] = useState('');
  const [fieldDefinitions, setFieldDefinitions] = useState([]);
  const [isParsingFields, setIsParsingFields] = useState(false);
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    if (!socket) return;

    const handleRamlAgentStarted = (data) => {
      if (data.tasks) {
        // Use tasks directly from the event if available
        setTasks(data.tasks);
        setSelectedTaskId(null);
        setIsLoading(false);
      }
      setApiName(data.apiName || 'MuleSoftAPI');
    };

    const handleEstimationUpdate = (data) => {
      if (data.estimation && tasks.length === 0) {
        const ramlTasks = extractRamlTasks(data.estimation);
        setTasks(ramlTasks);
        setSelectedTaskId(null);
        setIsLoading(false);
      }
    };

    socket.on('raml-agent-started', handleRamlAgentStarted);
    socket.on('session-update', handleEstimationUpdate);

    return () => {
      socket.off('raml-agent-started', handleRamlAgentStarted);
      socket.off('session-update', handleEstimationUpdate);
    };
  }, [socket, sessionId, tasks.length]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedTaskId(null);
      setSelectionError('');
      setRamlMode('without-fields');
      setFieldDefinitions([]);
      setFieldFileName('');
      setUploadError('');
    }
  }, [isOpen]);

  const selectedTask = tasks.find(task => task.id === selectedTaskId) || null;
  const isWithFields = ramlMode === 'with-fields';
  const hasFieldData = fieldDefinitions.length > 0;
  const canContinue = selectedTask && (!isWithFields || (hasFieldData && !isParsingFields));

  // Function to extract RAML-related tasks from the estimation
  const extractRamlTasks = (estimation) => {
    if (!estimation) return [];

    // Try to parse as JSON if it's a string
    let parsedEstimation;
    try {
      parsedEstimation = typeof estimation === 'string' ? JSON.parse(estimation) : estimation;
    } catch (e) {
      console.warn('Failed to parse estimation as JSON', e);
      return [];
    }

    // Extract tasks from the estimation structure
    if (parsedEstimation.breakdown) {
      return parsedEstimation.breakdown
        .filter(task =>
          task.type === 'API' ||
          task.task?.toLowerCase().includes('raml') ||
          task.task?.toLowerCase().includes('api')
        )
        .map(task => ({
          id: task.task || 'task-' + Math.random().toString(36).substr(2, 9),
          name: task.task,
          type: task.type || 'Development',
          complexity: task.complexity || 'Medium',
          hours: task.totalHours || 0,
          subtasks: task.subtasks || [],
          description: task.description || task.type || 'API Component'
        }));
    }
    return [];
  };

  const handleTaskSelect = (taskId) => {
    setSelectedTaskId(taskId);
    setSelectionError('');
  };

  const handleModeChange = (mode) => {
    setRamlMode(mode);
    setSelectionError('');
    setUploadError('');
    if (mode === 'without-fields') {
      setFieldDefinitions([]);
      setFieldFileName('');
    }
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

  const handleFieldFileChange = async (event) => {
    const file = event.target.files?.[0];
    setUploadError('');
    setFieldDefinitions([]);

    if (!file) {
      setFieldFileName('');
      return;
    }

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setUploadError('Please upload an Excel workbook (.xlsx).');
      return;
    }

    setFieldFileName(file.name);
    setIsParsingFields(true);

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

      setFieldDefinitions(normalized);
    } catch (error) {
      console.error('Failed to parse field definitions:', error);
      setUploadError(error.message || 'Failed to parse the uploaded file. Please verify the template.');
    } finally {
      setIsParsingFields(false);
    }
  };

  const handleConfirmSelection = () => {
    if (isLoading) return;

    if (!selectedTaskId) {
      setSelectionError('Please select an API to continue.');
      return;
    }

    if (isWithFields) {
      if (isParsingFields) {
        setSelectionError('Please wait until the Excel file finishes processing.');
        return;
      }
      if (!fieldDefinitions.length) {
        setSelectionError('Upload an Excel file with field definitions to continue.');
        return;
      }
    }

    if (!socket) {
      setSelectionError('Connection lost. Please refresh the page.');
      return;
    }

    if (!sessionId) {
      setSelectionError('Session not found. Please retry your request.');
      return;
    }

    const selectedApi = tasks.find(task => task.id === selectedTaskId);

    socket.emit('raml-agent-continue', {
      sessionId,
      timestamp: new Date().toISOString(),
      selectedApiId: selectedApi?.id,
      selectedApi,
      includeFields: isWithFields,
      fieldDefinitions: isWithFields ? fieldDefinitions : []
    });

    if (typeof onApiSelected === 'function' && selectedApi?.id) {
      onApiSelected(selectedApi.id);
    }

    onClose();
  };

  const handleClose = () => {
    handleConfirmSelection();
  };

  if (!isOpen) return null;  // Don't render anything if not open

  return (
    <div className="raml-modal-overlay">
      <div className="raml-modal">
        <div className="raml-modal-header">
          <h2>🔄 RAML Generation: {apiName}</h2>
          <button className="close-btn" onClick={handleClose}>&times;</button>
        </div>
        <div className="raml-modal-content">
          <div className="modal-description">
            <p>We're generating RAML specifications for your API. Here are the identified API components:</p>
            <p className="selection-hint">Select one API and choose whether to generate RAML with detailed field definitions.</p>
          </div>

          {isLoading ? (
            <div className="processing-container">
              <div className="processing-spinner"></div>
              <p className="processing-text">Analyzing requirements and identifying tasks...</p>
            </div>
          ) : tasks.length > 0 ? (
            <div className="tasks-container">
              <h3>Identified APIs</h3>
              <ul className="task-list">
                {tasks.map(task => (
                  <li
                    key={task.id}
                    className={`task-item selectable ${selectedTaskId === task.id ? 'selected' : ''}`}
                    onClick={() => handleTaskSelect(task.id)}
                  >
                    <div className="task-header">
                      <span className="task-name">{task.name}</span>
                    </div>
                    <div className="task-details">
                      <span className="task-type">{task.description}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {selectionError && (
                <div className="selection-error">
                  {selectionError}
                </div>
              )}
            </div>
          ) : (
            <div className="no-tasks">
              <p>No specific API components identified yet. The agent is still analyzing your requirements.</p>
            </div>
          )}

          {!isLoading && tasks.length > 0 && (
            <div className="raml-options">
              <h3>RAML Detail Options</h3>
              <div className="radio-group">
                <label className={`radio-option ${ramlMode === 'without-fields' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="raml-mode"
                    value="without-fields"
                    checked={ramlMode === 'without-fields'}
                    onChange={() => handleModeChange('without-fields')}
                  />
                  <div>
                    <span className="radio-title">Without Fields</span>
                    <p className="radio-description">Generate high-level RAML without explicit request/response schemas.</p>
                  </div>
                </label>

                <label className={`radio-option ${ramlMode === 'with-fields' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="raml-mode"
                    value="with-fields"
                    checked={ramlMode === 'with-fields'}
                    onChange={() => handleModeChange('with-fields')}
                  />
                  <div>
                    <span className="radio-title">With Fields</span>
                    <p className="radio-description">Use an Excel sheet to include detailed field definitions in the RAML.</p>
                  </div>
                </label>
              </div>

              {isWithFields && (
                <div className="fields-upload">
                  <label className="upload-label">
                    Upload field dictionary (.xlsx)
                    <input
                      type="file"
                      accept=".xlsx"
                      onChange={handleFieldFileChange}
                      disabled={isParsingFields}
                    />
                  </label>
                  <div className="upload-status">
                    {isParsingFields && <span>Processing spreadsheet...</span>}
                    {!isParsingFields && fieldFileName && (
                      <span>Loaded: {fieldFileName} ({fieldDefinitions.length} fields)</span>
                    )}
                  </div>
                  {uploadError && <div className="selection-error">{uploadError}</div>}
                  {fieldDefinitions.length > 0 && !uploadError && (
                    <div className="fields-summary">
                      <p><strong>{fieldDefinitions.length}</strong> field definitions detected and ready to use.</p>
                      <p className="fields-summary-note">Exact details won’t be displayed here, but will be applied to the RAML output.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="raml-modal-footer">
          <button
            className="primary-btn"
            disabled={isLoading || !canContinue}
            onClick={handleConfirmSelection}
          >
            {selectedTask
              ? isWithFields
                ? hasFieldData
                  ? `Generate RAML with fields for ${selectedTask.name}`
                  : 'Upload fields to continue'
                : `Generate RAML for ${selectedTask.name}`
              : 'Select an API to continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RamlAgentModal;
