import React, { useState } from 'react';
import './DateRangePicker.css';

/**
 * DateRangePicker Component
 * Allows users to select a date range with from/to date inputs
 */
const DateRangePicker = ({ onDateRangeChange, initialFromDate = null, initialToDate = null }) => {
  const [fromDate, setFromDate] = useState(initialFromDate || '');
  const [toDate, setToDate] = useState(initialToDate || '');
  const [isOpen, setIsOpen] = useState(false);
  const [activePreset, setActivePreset] = useState(null);

  // Get today's date in YYYY-MM-DD format
  const getTodayString = () => {
    const now = new Date();
    return now.toISOString().split('T')[0];
  };

  // Get a date string N days ago in YYYY-MM-DD format
  const getDateNDaysAgo = (days) => {
    const now = new Date();
    now.setDate(now.getDate() - days);
    return now.toISOString().split('T')[0];
  };

  const handleFromDateChange = (e) => {
    const value = e.target.value;
    setFromDate(value);
    setActivePreset(null);
    if (toDate && value > toDate) setToDate(value);
    onDateRangeChange({ fromDate: value, toDate });
  };

  const handleToDateChange = (e) => {
    const value = e.target.value;
    setToDate(value);
    setActivePreset(null);
    if (fromDate && value < fromDate) setFromDate(value);
    onDateRangeChange({ fromDate, toDate: value });
  };

  const handlePreset = (preset) => {
    const today = getTodayString();
    let newFromDate = today;
    let newToDate = today;

    switch (preset) {
      case 'today':
        newFromDate = today;
        newToDate = today;
        break;
      case 'week':
        newFromDate = getDateNDaysAgo(7);
        newToDate = today;
        break;
      case 'month':
        newFromDate = getDateNDaysAgo(30);
        newToDate = today;
        break;
      case 'quarter':
        newFromDate = getDateNDaysAgo(90);
        newToDate = today;
        break;
      case 'year':
        newFromDate = getDateNDaysAgo(365);
        newToDate = today;
        break;
      case 'all':
        newFromDate = '';
        newToDate = '';
        break;
      default:
        break;
    }

    setFromDate(newFromDate);
    setToDate(newToDate);
    setActivePreset(preset);
    onDateRangeChange({ fromDate: newFromDate, toDate: newToDate });
    setIsOpen(false);
  };

  const handleClear = () => {
    setFromDate('');
    setToDate('');
    setActivePreset(null);
    onDateRangeChange({ fromDate: '', toDate: '' });
  };

  const isCustomRange = fromDate || toDate;
  const displayText = isCustomRange
    ? `${fromDate || 'Start'} → ${toDate || 'End'}`
    : 'Date Range';

  const presets = [
    { key: 'today', label: 'Today' },
    { key: 'week',  label: 'This Week' },
    { key: 'month', label: 'This Month' },
    { key: 'quarter', label: '3 Months' },
    { key: 'year',  label: 'This Year' },
    { key: 'all',   label: 'All Time', extra: 'drp-preset-all' },
  ];

  return (
    <div className="date-range-picker">
      <button
        className={`drp-toggle-btn${isCustomRange ? ' active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Click to open date range picker"
      >
        📅 {displayText}
        <span className={`drp-arrow${isOpen ? ' open' : ''}`}>▼</span>
      </button>

      {isOpen && (
        <div className="drp-menu">
          <div className="drp-presets">
            {presets.map(({ key, label, extra }) => (
              <button
                key={key}
                className={`drp-preset-btn${extra ? ` ${extra}` : ''}${activePreset === key ? ' drp-preset-active' : ''}`}
                onClick={() => handlePreset(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Custom Range */}
          <div className="drp-custom">
            <div className="drp-divider">Custom Range</div>
            <div className="drp-inputs">
              <div className="drp-input-group">
                <label htmlFor="from-date">From:</label>
                <input
                  id="from-date"
                  type="date"
                  value={fromDate}
                  onChange={handleFromDateChange}
                  className="drp-input"
                />
              </div>
              <div className="drp-input-group">
                <label htmlFor="to-date">To:</label>
                <input
                  id="to-date"
                  type="date"
                  value={toDate}
                  onChange={handleToDateChange}
                  className="drp-input"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="drp-actions">
            <button
              className="drp-clear-btn"
              onClick={handleClear}
            >
              Clear
            </button>
            <button
              className="drp-close-btn"
              onClick={() => setIsOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DateRangePicker;
