import React from 'react';
import './TokenCategoryBadge.css';

/**
 * TokenCategoryBadge Component
 * Displays token category with color-coded badge and icon
 */
const TokenCategoryBadge = ({ category, size = 'medium', showIcon = true, showText = true }) => {
  // Normalize category values to display full names consistently
  const categoryAliases = {
    gen: 'General',
    general: 'General',
    arc: 'Architecture',
    architecture: 'Architecture',
    diagram: 'Diagram',
    dia: 'Diagram',
    estimation: 'Estimation',
    estimate: 'Estimation',
    raml: 'RAML',
    documentation: 'Documentation',
    doc: 'Documentation',
    docs: 'Documentation',
  };

  const normalizeCategory = (value) => {
    if (!value || typeof value !== 'string') return 'General';
    const key = value.trim().toLowerCase();
    if (categoryAliases[key]) return categoryAliases[key];
    return value.trim().split(/[-_\s]+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  };

  const normalizedCategory = normalizeCategory(category);

  const categoryColors = {
    'General': '#6366F1',        // Indigo
    'Architecture': '#3B82F6',   // Blue
    'Diagram': '#8B5CF6',        // Purple
    'Estimation': '#EC4899',     // Pink
    'RAML': '#F59E0B',           // Amber
    'Documentation': '#10B981',  // Emerald
  };

  const categoryIcons = {
    'General': '💬',
    'Architecture': '🏗️',
    'Diagram': '🎨',
    'Estimation': '📊',
    'RAML': '📋',
    'Documentation': '📚',
  };

  const color = categoryColors[normalizedCategory] || '#6366F1';
  const icon = categoryIcons[normalizedCategory] || '❓';
  const sizeClass = `tcb-${size}`;
  
  return (
    <span
      className={`token-category-badge ${sizeClass}`}
      title={normalizedCategory}
      style={{
        '--category-color': color
      }}
    >
      {showIcon && <span className="tcb-icon">{icon}</span>}
      {showText && <span className="tcb-text">{normalizedCategory}</span>}
    </span>
  );
};

export default TokenCategoryBadge;
