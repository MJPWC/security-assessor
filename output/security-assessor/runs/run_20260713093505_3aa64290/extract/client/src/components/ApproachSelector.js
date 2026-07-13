import React, { useState } from 'react';
import './ApproachSelector.css';

const ApproachSelector = ({ approaches: initialApproaches, onSelect, onClose }) => {
  const [approaches, setApproaches] = useState(initialApproaches.map(a => ({ ...a, isCustom: false, isEdited: false })));
  const [selectedApproach, setSelectedApproach] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', description: '' });
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState({ name: '', description: '' });
  const [customError, setCustomError] = useState('');

  const recommendedApproach = approaches.find(a => a.recommended);

  const handleCardClick = (approach) => {
    if (editingId !== null) return;
    setSelectedApproach(approach);
  };

  const handleSelect = () => {
    if (!selectedApproach) return;
    onSelect(selectedApproach);
  };

  const handleSelectRecommended = () => {
    if (recommendedApproach) {
      setSelectedApproach(recommendedApproach);
    }
  };

  // ── Edit ──────────────────────────────────────────────────────────────────
  const startEdit = (e, approach) => {
    e.stopPropagation();
    setEditingId(approach.number);
    setEditDraft({ name: approach.name, description: approach.description });
  };

  const cancelEdit = (e) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const saveEdit = (e, approach) => {
    e.stopPropagation();
    if (!editDraft.name.trim() || !editDraft.description.trim()) return;
    const updated = approaches.map(a =>
      a.number === approach.number
        ? { ...a, name: editDraft.name.trim(), description: editDraft.description.trim(), isEdited: true }
        : a
    );
    setApproaches(updated);
    if (selectedApproach?.number === approach.number) {
      setSelectedApproach(updated.find(a => a.number === approach.number));
    }
    setEditingId(null);
  };

  // ── Custom Approach ────────────────────────────────────────────────────────
  const handleAddCustom = () => {
    setCustomError('');
    if (!customDraft.name.trim()) { setCustomError('Please enter an approach name.'); return; }
    if (!customDraft.description.trim()) { setCustomError('Please describe your approach.'); return; }

    const newNumber = Math.max(...approaches.map(a => a.number), 0) + 1;
    const newApproach = {
      number: newNumber,
      name: customDraft.name.trim(),
      description: customDraft.description.trim(),
      recommended: false,
      isCustom: true,
      isEdited: false,
    };
    setApproaches(prev => [...prev, newApproach]);
    setSelectedApproach(newApproach);
    setCustomDraft({ name: '', description: '' });
    setShowAddCustom(false);
  };

  const renderDescription = (description) =>
    description.split('\n').map((line, i) => {
      const t = line.trim();
      if (!t) return <br key={i} />;
      if (/^[A-Z][^:]*:/.test(t)) return <div key={i} className="description-header">{t}</div>;
      if (t.startsWith('- ') || t.startsWith('• ')) return <div key={i} className="description-bullet">{t}</div>;
      if (/^\d+\./.test(t)) return <div key={i} className="description-numbered">{t}</div>;
      return <div key={i} className="description-text">{t}</div>;
    });

  return (
    <div className="approach-selector-overlay">
      <div className="approach-selector-modal">
        <div className="approach-selector-header">
          <h2>🏗️ Architecture Approaches</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="approach-selector-content">
          <p className="selector-description">
            The Architecture Agent has generated {approaches.length} different approaches for your requirements.
            Please select which approach you would like to proceed with.
          </p>

          {recommendedApproach && (
            <div className="recommended-banner">
              <span className="recommended-badge">⭐ Recommended</span>
              <span className="recommended-text">
                Approach {recommendedApproach.number}: {recommendedApproach.name}
              </span>
              <button className="select-recommended-btn" onClick={handleSelectRecommended}>
                Use Recommended
              </button>
            </div>
          )}

          <div className="approaches-list">
            {approaches.map((approach) => {
              const isEditing = editingId === approach.number;
              const isSelected = selectedApproach?.number === approach.number;

              return (
                <div
                  key={approach.number}
                  className={`approach-card ${isSelected ? 'selected' : ''} ${approach.recommended ? 'recommended' : ''} ${isEditing ? 'editing' : ''}`}
                  onClick={() => !isEditing && handleCardClick(approach)}
                >
                  <div className="approach-header">
                    <h3>
                      Approach {approach.number}:{' '}
                      {isEditing ? (
                        <input
                          className="edit-name-input"
                          value={editDraft.name}
                          onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))}
                          onClick={e => e.stopPropagation()}
                          placeholder="Approach name"
                        />
                      ) : (
                        approach.name
                      )}
                      {approach.recommended && !isEditing && <span className="recommended-tag">⭐ Recommended</span>}
                      {approach.isEdited && !isEditing && <span className="edited-tag">✏️ Edited</span>}
                      {approach.isCustom && !isEditing && <span className="custom-tag">✨ Custom</span>}
                    </h3>
                    <div className="approach-card-actions">
                      {!isEditing ? (
                        <button
                          className="edit-approach-btn"
                          title="Edit this approach"
                          onClick={e => startEdit(e, approach)}
                        >
                          ✏️ Edit
                        </button>
                      ) : (
                        <>
                          <button
                            className="save-approach-btn"
                            onClick={e => saveEdit(e, approach)}
                            disabled={!editDraft.name.trim() || !editDraft.description.trim()}
                          >
                            Save
                          </button>
                          <button className="cancel-approach-btn" onClick={cancelEdit}>Cancel</button>
                        </>
                      )}
                    </div>
                  </div>

                  {approach.recommended && approach.recommendationReason && !isEditing && (
                    <div className="rec-reason-note">
                      <strong>Why recommended:</strong> {approach.recommendationReason}
                    </div>
                  )}

                  <div className="approach-description">
                    {isEditing ? (
                      <textarea
                        className="edit-desc-textarea"
                        value={editDraft.description}
                        onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))}
                        onClick={e => e.stopPropagation()}
                        rows={8}
                        placeholder="Describe the approach details, components, pros/cons..."
                      />
                    ) : (
                      <div className="formatted-description">{renderDescription(approach.description)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Custom Approach */}
          {!showAddCustom ? (
            <button className="add-custom-toggle-btn" onClick={() => setShowAddCustom(true)}>
              + Add Your Own Approach
            </button>
          ) : (
            <div className="custom-approach-form">
              <div className="custom-form-header">
                <span>✨ Define Your Own Approach</span>
                <button className="custom-form-close" onClick={() => { setShowAddCustom(false); setCustomError(''); }}>×</button>
              </div>
              <input
                className="custom-name-input"
                value={customDraft.name}
                onChange={e => { setCustomDraft(d => ({ ...d, name: e.target.value })); setCustomError(''); }}
                placeholder="Approach name (e.g. Event-Driven with Kafka)"
              />
              <textarea
                className="custom-desc-textarea"
                value={customDraft.description}
                onChange={e => { setCustomDraft(d => ({ ...d, description: e.target.value })); setCustomError(''); }}
                rows={6}
                placeholder="Describe your approach — components, integration patterns, pros/cons..."
              />
              {customError && <div className="custom-form-error">{customError}</div>}
              <button className="custom-add-btn" onClick={handleAddCustom}>
                Add Approach
              </button>
            </div>
          )}

          <div className="approach-input-section">
            {selectedApproach ? (
              <div className="success-message">
                ✓ Selected: Approach {selectedApproach.number} - {selectedApproach.name}
                {selectedApproach.isCustom && ' (your custom approach)'}
                {selectedApproach.isEdited && ' (edited)'}
              </div>
            ) : (
              <p className="select-hint">Click an approach card above to select it, then confirm below.</p>
            )}
            <div className="input-group">
              <button
                onClick={handleSelect}
                disabled={!selectedApproach}
                className="select-btn"
              >
                Select &amp; Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApproachSelector;
