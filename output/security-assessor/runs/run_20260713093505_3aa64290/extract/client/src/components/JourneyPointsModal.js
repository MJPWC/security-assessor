import React, { useState, useEffect } from 'react';
import './JourneyPointsModal.css';

/**
 * Parses user stories / integration flows out of an architecture string.
 * Returns an array of strings (one per story/journey point found).
 */
const parseUserStoriesFromArchitecture = (architecture) => {
  if (!architecture || typeof architecture !== 'string') return [];

  const stories = [];

  // Try to find JSON block first
  try {
    const jsonMatch = architecture.match(/```json\s*([\s\S]*?)```/i) ||
                      architecture.match(/\{[\s\S]*"userStories"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      const arr = parsed.userStories || parsed.user_stories || parsed.journeys || [];
      if (Array.isArray(arr) && arr.length) {
        arr.forEach(s => {
          const text = typeof s === 'string' ? s : (s.story || s.description || s.title || '');
          if (text.trim()) stories.push(text.trim());
        });
        if (stories.length) return stories.slice(0, 2);
      }
    }
  } catch (_) {}

  // Regex patterns to find user story / integration flow lines
  const patterns = [
    /(?:user stor(?:y|ies)|integration flow|user journey|use case|workflow)[:\s]*([^\n]{10,200})/gi,
    /(?:as a [^,\n]{3,}),\s*(?:i want to|i need to)[^\n]{5,200}/gi,
    /(?:\d+\.\s+|[-•*]\s+)([A-Z][^.\n]{15,200}(?:to|from|with|via|through|between)[^.\n]{5,100})/g,
  ];

  patterns.forEach(pattern => {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(architecture)) !== null) {
      const text = (match[1] || match[0]).trim().replace(/^[-•*\d.\s]+/, '');
      if (text.length > 10 && !stories.includes(text)) {
        stories.push(text);
      }
      if (stories.length >= 1) break;
    }
  });

  // Fallback: grab numbered/bulleted list items that look like flows
  if (stories.length < 1) {
    const listItems = architecture.match(/(?:^\s*[-•*]\s+.+|^\s*\d+\.\s+.+)/gm) || [];
    for (const item of listItems) {
      const text = item.replace(/^\s*[-•*\d.\s]+/, '').trim();
      if (text.length > 15 && !stories.includes(text)) {
        stories.push(text);
      }
      if (stories.length >= 1) break;
    }
  }

  return stories.slice(0, 1);
};

const JourneyPointsModal = ({ onSubmit, onClose, onError = null, isProcessing = false, architecture = null, useCases = null }) => {
  const [points, setPoints] = useState(['']); // Start with 1 empty point
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pre-populate from the extracted use cases (preferred), else parse architecture
  useEffect(() => {
    if (Array.isArray(useCases) && useCases.length > 0) {
      const fromUseCases = useCases
        .map(u => (u.description ? `${u.name} - ${u.description}` : u.name))
        .map(s => (s || '').trim())
        .filter(Boolean);
      if (fromUseCases.length > 0) {
        setPoints(fromUseCases);
        return;
      }
    }
    if (architecture) {
      const parsed = parseUserStoriesFromArchitecture(architecture);
      if (parsed.length > 0) {
        setPoints([...parsed]);
      }
    }
  }, [architecture, useCases]);

  const handlePointChange = (index, value) => {
    const newPoints = [...points];
    newPoints[index] = value;
    setPoints(newPoints);
    if (errors[index]) {
      const newErrors = { ...errors };
      delete newErrors[index];
      setErrors(newErrors);
    }
  };

  const handleAddPoint = () => {
    setPoints(prev => [...prev, '']);
  };

  const handleRemovePoint = (index) => {
    if (points.length <= 1) return;
    setPoints(prev => prev.filter((_, i) => i !== index));
    setErrors(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const isSingleWord = (text) => {
    const trimmed = text.trim();
    return trimmed.length > 0 && !trimmed.includes(' ') && !trimmed.includes('.') && !trimmed.includes(',');
  };

  const validatePoints = () => {
    const newErrors = {};
    let hasErrors = false;

    points.forEach((point, index) => {
      const trimmed = point.trim();
      if (trimmed.length === 0) return;

      if (isSingleWord(trimmed)) {
        newErrors[index] = 'Each point must be a sentence, not a single word.';
        hasErrors = true;
        return;
      }

      const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
      if (wordCount < 2) {
        newErrors[index] = 'Each point must be a complete sentence with multiple words.';
        hasErrors = true;
      }
    });

    setErrors(newErrors);
    return !hasErrors;
  };

  const handleSubmit = () => {
    if (!validatePoints()) return;
    setIsSubmitting(true);
    const validPoints = points.map(p => p.trim()).filter(p => p.length > 0);
    try {
      onSubmit(validPoints);
    } catch (error) {
      console.error('Error submitting journey points:', error);
      onError?.(error, 'Failed to submit journey points');
      setIsSubmitting(false);
    }
  };

  const hasPrepopulated = points.some(p => p.trim().length > 0);

  return (
    <div className="journey-modal-overlay">
      <div className="journey-modal">
        <div className="journey-modal-header">
          <h2>📋 User Stories for Estimation</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="journey-modal-content">
          {hasPrepopulated && architecture ? (
            <div className="modal-description" style={{ background: '#fff8f0', borderLeft: '4px solid #FF6B00', padding: '10px 14px', borderRadius: '4px', marginBottom: '12px' }}>
              <strong>✅ Auto-populated from Architecture</strong>
              <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#555' }}>
                User stories below were extracted from your architecture. Review and edit them before submitting.
              </p>
            </div>
          ) : (
            <div className="modal-description">
              <strong>For Example:</strong>
              <ul>
                <li>Client Register - Client Portal to MuleSoft to Salesforce &amp; Database.</li>
                <li>Order Create &amp; Update - Client Portal UI to MuleSoft to Database.</li>
              </ul>
              <p style={{ color: 'orange', fontWeight: 'bold' }}>⚠️ Avoid one word answers like yes, no, ok etc.</p>
            </div>
          )}

          {errors['_general'] && (
            <div className="error-message general-error">⚠️ {errors['_general']}</div>
          )}

          {!isProcessing && (
            <div className="journey-points-list">
              {points.map((point, index) => (
                <div key={index} className={`journey-point-row ${errors[index] ? 'error' : ''}`}>
                  <div className="journey-point-number">{index + 1}</div>
                  <textarea
                    value={point}
                    onChange={(e) => handlePointChange(index, e.target.value)}
                    placeholder="Enter user journey (must be a complete sentence)..."
                    rows="2"
                    className={`journey-point-input ${errors[index] ? 'error' : ''}`}
                    disabled={isProcessing}
                  />
                  <button
                    type="button"
                    className="journey-remove-btn"
                    onClick={() => handleRemovePoint(index)}
                    disabled={points.length <= 1}
                    title="Remove this story"
                  >✕</button>
                  {errors[index] && (
                    <div className="error-message journey-inline-error">⚠️ {errors[index]}</div>
                  )}
                </div>
              ))}
              <button type="button" className="journey-add-btn" onClick={handleAddPoint}>
                + Add User Story
              </button>
            </div>
          )}

          {isProcessing ? (
            <div className="processing-state">
              <div className="processing-spinner"></div>
              <h3>Processing Your Journey Points...</h3>
              <p>Generating estimation based on your journey points, architecture information, and diagram.</p>
            </div>
          ) : (
            <div className="journey-modal-footer">
              <button className="cancel-btn" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button className="submit-btn" onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default JourneyPointsModal;
