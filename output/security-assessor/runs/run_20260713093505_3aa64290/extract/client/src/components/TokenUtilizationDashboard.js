import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import './TokenUtilizationDashboard.css';
import DateRangePicker from './DateRangePicker.jsx';
import TokenCategoryBadge from './TokenCategoryBadge.jsx';
import CorrelationIDDisplay from './CorrelationIDDisplay.jsx';
import API_BASE_URL from '../config';

// ─── Provider color map (MuleSoft-inspired palette) ──────────────────────────
const PROVIDER_COLORS = {
  anthropic:  { bg: '#FFF3E0', accent: '#FF6B00', text: '#8A4500', chart: '#FF6B00' },
  openai:     { bg: '#E8F7F0', accent: '#10A37F', text: '#0D6B53', chart: '#10A37F' },
  openrouter: { bg: '#FDF0E8', accent: '#F5A623', text: '#8A5700', chart: '#F5A623' },
  gemini:     { bg: '#EAF0FB', accent: '#4285F4', text: '#1A3A8F', chart: '#4285F4' },
  groq:       { bg: '#F3E8FF', accent: '#9333EA', text: '#581C87', chart: '#9333EA' },
  default:    { bg: '#FFF3E0', accent: '#FF6B00', text: '#8A4500', chart: '#FF6B00' },
};

const CATEGORY_COLORS = ['#FF6B00', '#F5A623', '#4CAF50', '#E91E63', '#9C27B0', '#FF5722'];

const getProviderStyle = (name = '') =>
  PROVIDER_COLORS[name.toLowerCase()] || PROVIDER_COLORS.default;

const normalizeCategory = (value) => {
  if (!value || typeof value !== 'string') return 'General';
  const normalized = value.trim().toLowerCase();
  const aliases = {
    gen: 'General', general: 'General',
    arc: 'Architecture', architecture: 'Architecture',
    diagram: 'Diagram', dia: 'Diagram',
    estimation: 'Estimation', estimate: 'Estimation',
    raml: 'RAML',
    documentation: 'Documentation', doc: 'Documentation', docs: 'Documentation',
  };
  if (aliases[normalized]) return aliases[normalized];
  return value.trim().split(/[-_\s]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
};

const fmt = (n) => (n || 0).toLocaleString();

// ─── SVG Donut Chart ─────────────────────────────────────────────────────────
const DonutChart = ({ data, size = 180, thickness = 36 }) => {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <div className="tud-chart-empty">No data</div>;

  const cx = size / 2, cy = size / 2, r = (size - thickness) / 2;
  let cumAngle = -Math.PI / 2;
  const arcs = data.map(d => {
    const angle = (d.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(cumAngle);
    const y1 = cy + r * Math.sin(cumAngle);
    cumAngle += angle;
    const x2 = cx + r * Math.cos(cumAngle);
    const y2 = cy + r * Math.sin(cumAngle);
    const large = angle > Math.PI ? 1 : 0;
    return { ...d, path: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`, pct: Math.round((d.value / total) * 100) };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {arcs.map((arc, i) => (
        <path key={i} d={arc.path} fill="none" stroke={arc.color} strokeWidth={thickness}
          strokeLinecap="round">
          <title>{arc.label}: {fmt(arc.value)} ({arc.pct}%)</title>
        </path>
      ))}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="22" fontWeight="700" fill="#1a1a2e">{fmt(total)}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize="10" fill="#888">total tokens</text>
    </svg>
  );
};

// ─── SVG Bar Chart ────────────────────────────────────────────────────────────
const BarChart = ({ data, height = 160, color = '#FF6B00', labelKey = 'label', valueKey = 'value' }) => {
  const maxVal = Math.max(...data.map(d => d[valueKey]), 1);
  const barW = Math.max(20, Math.floor(320 / Math.max(data.length, 1)) - 8);
  const totalW = data.length * (barW + 8) + 20;

  return (
    <svg width="100%" viewBox={`0 0 ${totalW} ${height + 30}`} preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}>
      {data.map((d, i) => {
        const barH = Math.max(4, Math.round((d[valueKey] / maxVal) * height));
        const x = 10 + i * (barW + 8);
        const y = height - barH;
        const label = String(d[labelKey] || '').substring(0, 8);
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} fill={color} rx={4} opacity={0.85}>
              <title>{d[labelKey]}: {fmt(d[valueKey])}</title>
            </rect>
            <text x={x + barW / 2} y={height + 14} textAnchor="middle" fontSize="9" fill="#666">{label}</text>
          </g>
        );
      })}
    </svg>
  );
};

// ─── SVG Line Chart ────────────────────────────────────────────────────────────
const LineChart = ({ data, height = 120, color = '#FF6B00', valueKey = 'value', labelKey = 'label' }) => {
  if (!data || data.length < 2) return <div className="tud-chart-empty">Not enough data</div>;
  const yAxisW = 52, xAxisH = 24, padTop = 10, padRight = 10;
  const w = 320, h = height;
  const chartW = w - yAxisW - padRight;
  const chartH = h - xAxisH - padTop;
  const maxVal = Math.max(...data.map(d => d[valueKey]), 1);

  // 4 Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    val: Math.round(maxVal * f),
    y: padTop + chartH - f * chartH,
  }));

  const pts = data.map((d, i) => ({
    x: yAxisW + (i / (data.length - 1)) * chartW,
    y: padTop + chartH - ((d[valueKey] / maxVal) * chartH),
    ...d
  }));
  const polyline = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area = `M ${pts[0].x} ${padTop + chartH} ` + pts.map(p => `L ${p.x} ${p.y}`).join(' ') + ` L ${pts[pts.length-1].x} ${padTop + chartH} Z`;

  // Show at most 5 x-labels evenly spaced
  const xLabelIndices = data.length <= 5
    ? data.map((_, i) => i)
    : [0, Math.floor((data.length-1)*0.25), Math.floor((data.length-1)*0.5), Math.floor((data.length-1)*0.75), data.length-1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Y-axis gridlines and labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={yAxisW} y1={t.y} x2={w - padRight} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3,3" />
          <text x={yAxisW - 4} y={t.y + 4} textAnchor="end" fontSize="9" fill="#888">
            {t.val >= 1000 ? `${(t.val/1000).toFixed(1)}k` : t.val}
          </text>
        </g>
      ))}
      {/* Y-axis line */}
      <line x1={yAxisW} y1={padTop} x2={yAxisW} y2={padTop + chartH} stroke="#d1d5db" strokeWidth="1" />
      {/* Area fill */}
      <path d={area} fill="url(#lineGrad)" />
      {/* Line */}
      <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" />
      {/* Data points */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill={color}>
          <title>{p[labelKey]}: {fmt(p[valueKey])}</title>
        </circle>
      ))}
      {/* X-axis labels */}
      {xLabelIndices.map(i => (
        <text key={i} x={pts[i].x} y={padTop + chartH + 16} textAnchor="middle" fontSize="9" fill="#666">
          {data[i][labelKey]}
        </text>
      ))}
    </svg>
  );
};

// ─── Stat Card ─────────────────────────────────────────────────────────────────
const StatCard = ({ icon, label, value, sub, trend, accent = '#FF6B00' }) => (
  <div className="tud-stat-card" style={{ '--card-accent': accent }}>
    <div className="tud-stat-icon-wrap" style={{ background: accent + '18' }}>
      <span className="tud-stat-icon">{icon}</span>
    </div>
    <div className="tud-stat-body">
      <span className="tud-stat-label">{label}</span>
      <span className="tud-stat-value">{value}</span>
      {sub && <span className="tud-stat-sub">{sub}</span>}
      {trend !== undefined && (
        <span className={`tud-stat-trend ${trend >= 0 ? 'up' : 'down'}`}>
          {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </span>
      )}
    </div>
  </div>
);

// ─── Spinner ───────────────────────────────────────────────────────────────────
const Spinner = () => (
  <div className="tud-spinner-wrap">
    <div className="tud-spinner" />
    <p>Loading token usage data…</p>
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────
const TokenUtilizationDashboard = () => {
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);
  const [data, setData]                     = useState(null);
  const [timeRange, setTimeRange]           = useState('all');
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [statusFilter, setStatusFilter]     = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [correlationIdFilter, setCorrelationIdFilter] = useState('');
  const [sortConfig, setSortConfig]         = useState({ key: 'timestamp', direction: 'desc' });
  const [activeView, setActiveView]         = useState('overview'); // 'overview' | 'table'
  const [dateRange, setDateRange]           = useState({ fromDate: null, toDate: null });
  const [expandedRow, setExpandedRow]       = useState(null);
  const [currentPage, setCurrentPage]       = useState(1);
  const PAGE_SIZE = 20;

  const fetchTokenData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get(`${API_BASE_URL}/api/token-usage`);
      setData(response.data);
    } catch (err) {
      let msg = 'Failed to fetch token usage data.';
      if (err?.code === 'ERR_NETWORK' || err?.message?.includes('Network Error')) msg = 'Cannot connect to backend server.';
      else if (err?.response?.status === 404) msg = 'API endpoint /api/token-usage not found.';
      else if (err?.message) msg = err.message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokenData();
    const id = setInterval(fetchTokenData, 30000);
    return () => clearInterval(id);
  }, [fetchTokenData]);

  const handleDateRangeChange = ({ fromDate, toDate }) => {
    setDateRange({ fromDate, toDate });
    if (fromDate || toDate) setTimeRange('custom');
  };

  const toggleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortArrow = (key) =>
    sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : '';

  const filteredData = useMemo(() => {
    if (!data?.entries) return [];
    let rows = [...data.entries];

    if (selectedProvider !== 'all') rows = rows.filter(e => e.llmProvider === selectedProvider);
    if (statusFilter !== 'all') rows = rows.filter(e => e.status === statusFilter);
    if (categoryFilter !== 'all') rows = rows.filter(e => normalizeCategory(e.tokenCategory) === categoryFilter);
    if (correlationIdFilter.trim()) {
      const search = correlationIdFilter.trim().toLowerCase();
      rows = rows.filter(e => (e.correlationId || '').toLowerCase().includes(search));
    }

    if (timeRange !== 'all' || dateRange.fromDate || dateRange.toDate) {
      const now = new Date();
      let from, to = new Date();
      if (timeRange === 'custom') {
        if (dateRange.fromDate) from = new Date(dateRange.fromDate);
        if (dateRange.toDate) { to = new Date(dateRange.toDate); to.setHours(23, 59, 59, 999); }
      } else if (timeRange === 'today') {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (timeRange === 'week') {
        from = new Date(now.getTime() - 7 * 86400000);
      } else if (timeRange === 'month') {
        from = new Date(now.getTime() - 30 * 86400000);
      }
      if (from) {
        rows = rows.filter(e => {
          const clean = (e.timestamp || '').replace(' IST', '').trim();
          const d = new Date(clean);
          return !isNaN(d) && d >= from && d <= to;
        });
      }
    }

    rows.sort((a, b) => {
      let av = a[sortConfig.key], bv = b[sortConfig.key];
      const numKeys = ['promptTokens', 'completionTokens', 'totalTokens'];
      if (numKeys.includes(sortConfig.key)) { av = parseInt(av) || 0; bv = parseInt(bv) || 0; }
      if (av < bv) return sortConfig.direction === 'asc' ? -1 : 1;
      if (av > bv) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return rows;
  }, [data, selectedProvider, statusFilter, categoryFilter, correlationIdFilter, timeRange, sortConfig, dateRange]);

  const metrics = useMemo(() => {
    const rows = filteredData;
    if (!rows.length) return {
      totalRequests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0,
      avgTokens: 0, successRate: 0, errorRate: 0, providers: [], topModels: [],
      statusBreakdown: {}, categoryBreakdown: [], tokensByDay: []
    };

    let totalTokens = 0, promptTokens = 0, completionTokens = 0, success = 0;
    const provMap = {}, modelMap = {}, statusMap = {}, catMap = {}, dayMap = {};

    rows.forEach(e => {
      const p = parseInt(e.promptTokens) || 0;
      const c = parseInt(e.completionTokens) || 0;
      promptTokens    += p;
      completionTokens += c;
      totalTokens     += p + c;
      if (e.status === 'success') success++;
      statusMap[e.status] = (statusMap[e.status] || 0) + 1;

      const prov = e.llmProvider || 'unknown';
      if (!provMap[prov]) provMap[prov] = { requests: 0, tokens: 0, errors: 0 };
      provMap[prov].requests++;
      provMap[prov].tokens += p + c;
      if (e.status !== 'success') provMap[prov].errors++;

      const mdl = e.modelName || 'unknown';
      if (!modelMap[mdl]) modelMap[mdl] = { requests: 0, tokens: 0 };
      modelMap[mdl].requests++;
      modelMap[mdl].tokens += p + c;

      const cat = normalizeCategory(e.tokenCategory);
      catMap[cat] = (catMap[cat] || 0) + (p + c);

      // Group by day
      const dayStr = (e.timestamp || '').substring(0, 10);
      if (dayStr) {
        if (!dayMap[dayStr]) dayMap[dayStr] = 0;
        dayMap[dayStr] += p + c;
      }
    });

    const categoryBreakdown = Object.entries(catMap)
      .map(([label, value], i) => ({ label, value, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }))
      .sort((a, b) => b.value - a.value);

    const tokensByDay = Object.entries(dayMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label: label.slice(5), value })); // MM-DD

    return {
      totalRequests: rows.length,
      totalTokens, promptTokens, completionTokens,
      avgTokens: Math.round(totalTokens / rows.length),
      successRate: Math.round((success / rows.length) * 100),
      errorRate: Math.round(((rows.length - success) / rows.length) * 100),
      providers: Object.entries(provMap)
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.requests - a.requests),
      topModels: Object.entries(modelMap)
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 6),
      statusBreakdown: statusMap,
      categoryBreakdown,
      tokensByDay,
    };
  }, [filteredData]);

  const pageCount = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredData.slice(start, start + PAGE_SIZE);
  }, [filteredData, currentPage]);

  const availableProviders = useMemo(() => {
    if (!data?.entries) return [];
    return [...new Set(data.entries.map(e => e.llmProvider).filter(Boolean))].sort();
  }, [data]);

  const availableCategories = useMemo(() => {
    if (!data?.entries) return [];
    return [...new Set(data.entries.map(e => normalizeCategory(e.tokenCategory)).filter(Boolean))].sort();
  }, [data]);

  useEffect(() => { setCurrentPage(1); },
    [selectedProvider, statusFilter, categoryFilter, correlationIdFilter, timeRange, dateRange]);

  if (loading && !data) return <div className="tud-root"><Spinner /></div>;
  if (error && !data) return (
    <div className="tud-root">
      <div className="tud-error-wrap">
        <div className="tud-error-icon">⚠️</div>
        <h3>Could not reach server</h3>
        <p>{error}</p>
        <p className="tud-error-hint">Start the backend with <code>npm run server</code> and click Retry.</p>
        <button className="tud-retry-btn" onClick={fetchTokenData}>🔄 Retry</button>
      </div>
    </div>
  );

  return (
    <div className="tud-root">

      {/* ── MuleSoft-Style Header ─────────────────────────────────────── */}
      <header className="tud-header">
        <div className="tud-header-left">
          <div className="tud-ms-logo">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="14" fill="#FF6B00"/>
              <text x="14" y="19" textAnchor="middle" fontSize="13" fontWeight="bold" fill="white">M</text>
            </svg>
          </div>
          <div>
            <h1 className="tud-title">Token Utilization</h1>
            <p className="tud-subtitle">LLM usage analytics across all agents &amp; providers</p>
          </div>
          <div className="tud-header-badge">LIVE</div>
        </div>
        <div className="tud-header-right">
          <span className="tud-last-updated">
            ⏱ {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <button className="tud-refresh-btn" onClick={fetchTokenData} title="Refresh data">↻ Refresh</button>
        </div>
      </header>

      {error && (
        <div className="tud-inline-warn">
          ⚠️ Showing cached data · {error}
          <button onClick={fetchTokenData}>Retry</button>
        </div>
      )}

      {/* ── KPI Stat Cards ─────────────────────────────────────────────── */}
      <section className="tud-stats">
        <StatCard icon="📨" label="Total Requests" value={fmt(metrics.totalRequests)} accent="#FF6B00" />
        <StatCard icon="🔤" label="Total Tokens" value={fmt(metrics.totalTokens)}
          sub={`${fmt(metrics.promptTokens)} prompt · ${fmt(metrics.completionTokens)} completion`}
          accent="#FF8F00" />
        <StatCard icon="⌀" label="Avg per Request" value={fmt(metrics.avgTokens)} accent="#059669" />
        <StatCard icon="✅" label="Success Rate" value={`${metrics.successRate}%`}
          sub={`${metrics.errorRate}% errors`}
          accent={metrics.successRate >= 80 ? '#059669' : '#DC2626'} />
      </section>

      {/* ── Filter Controls (MuleSoft pill + select style) ─────────────── */}
      <section className="tud-controls">
        <div className="tud-control-row">
          <div className="tud-control-group">
            <label className="tud-label">Time Range</label>
            <div className="tud-pill-group">
              {['all', 'today', 'week', 'month'].map(r => (
                <button key={r}
                  className={`tud-pill ${timeRange === r ? 'active' : ''}`}
                  onClick={() => { setTimeRange(r); setDateRange({ fromDate: null, toDate: null }); }}>
                  {r === 'all' ? 'All Time' : r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="tud-control-group">
            <label className="tud-label">Provider</label>
            <select className="tud-select" value={selectedProvider} onChange={e => setSelectedProvider(e.target.value)}>
              <option value="all">All Providers</option>
              {availableProviders.map(p => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </div>

          <div className="tud-control-group">
            <label className="tud-label">Category</label>
            <select className="tud-select" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              <option value="all">All Categories</option>
              {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="tud-control-group">
            <label className="tud-label">Status</label>
            <select className="tud-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All Status</option>
              <option value="success">✅ Success</option>
              <option value="error">❌ Error</option>
            </select>
          </div>

          <div className="tud-control-group">
            <label className="tud-label">Custom Dates</label>
            <DateRangePicker onDateRangeChange={handleDateRangeChange}
              initialFromDate={dateRange.fromDate} initialToDate={dateRange.toDate} />
          </div>

          <div className="tud-control-group">
            <label className="tud-label">Correlation ID</label>
            <input className="tud-input" value={correlationIdFilter}
              onChange={e => setCorrelationIdFilter(e.target.value)}
              placeholder="Search correlation id" />
          </div>
        </div>

        <div className="tud-view-toggle">
          <button className={`tud-view-btn ${activeView === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveView('overview')}>
            📊 Overview
          </button>
          <button className={`tud-view-btn ${activeView === 'table' ? 'active' : ''}`}
            onClick={() => setActiveView('table')}>
            📋 Detail Table
          </button>
        </div>
      </section>

      {/* ── Overview (Charts) ─────────────────────────────────────────── */}
      {activeView === 'overview' && (
        <section className="tud-overview-grid">

          {/* Token Distribution Donut */}
          <div className="tud-chart-card tud-chart-card--donut">
            <h2 className="tud-chart-title">Token Distribution by Category</h2>
            <div className="tud-donut-wrap">
              <DonutChart
                data={metrics.categoryBreakdown.length ? metrics.categoryBreakdown : [{ label: 'No data', value: 1, color: '#e0e0e0' }]}
                size={180}
                thickness={36}
              />
              <div className="tud-donut-legend">
                {metrics.categoryBreakdown.map((d, i) => (
                  <div key={i} className="tud-legend-item">
                    <span className="tud-legend-dot" style={{ background: d.color }} />
                    <span className="tud-legend-label">{d.label}</span>
                    <span className="tud-legend-val">{fmt(d.value)}</span>
                  </div>
                ))}
                {metrics.categoryBreakdown.length === 0 && <p className="tud-no-data">No data</p>}
              </div>
            </div>
          </div>

          {/* Tokens Over Time Line */}
          <div className="tud-chart-card tud-chart-card--line">
            <h2 className="tud-chart-title">Tokens Over Time</h2>
            {metrics.tokensByDay.length >= 2 ? (
              <LineChart data={metrics.tokensByDay} height={130} color="#FF6B00" valueKey="value" labelKey="label" />
            ) : (
              <div className="tud-chart-empty">Not enough data points</div>
            )}
          </div>

          {/* Provider Usage Bar */}
          <div className="tud-chart-card tud-chart-card--bar">
            <h2 className="tud-chart-title">Usage by Provider</h2>
            {metrics.providers.length === 0 ? (
              <p className="tud-no-data">No provider data</p>
            ) : (
              <>
                <BarChart
                  data={metrics.providers.map(p => ({ label: p.name, value: p.tokens }))}
                  height={130}
                  color="#FF6B00"
                  labelKey="label"
                  valueKey="value"
                />
                <div className="tud-provider-list">
                  {metrics.providers.map((prov, i) => {
                    const style = getProviderStyle(prov.name);
                    const maxReqs = Math.max(...metrics.providers.map(p => p.requests), 1);
                    const pct = Math.round((prov.requests / maxReqs) * 100);
                    return (
                      <div key={i} className="tud-prov-row">
                        <div className="tud-prov-header">
                          <span className="tud-prov-badge"
                            style={{ background: style.bg, color: style.text, borderColor: style.accent }}>
                            {prov.name.toUpperCase()}
                          </span>
                          <div className="tud-prov-stats">
                            <span>{prov.requests} req</span>
                            {prov.errors > 0 && <span className="tud-prov-errors">{prov.errors} err</span>}
                            <span className="tud-prov-tokens">{fmt(prov.tokens)} tok</span>
                          </div>
                        </div>
                        <div className="tud-bar-track">
                          <div className="tud-bar-fill" style={{ width: `${pct}%`, background: style.accent }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Top Models */}
          <div className="tud-chart-card tud-chart-card--models">
            <h2 className="tud-chart-title">Top Models</h2>
            {metrics.topModels.length === 0 ? (
              <p className="tud-no-data">No model data</p>
            ) : (
              <div className="tud-model-list">
                {metrics.topModels.map((mdl, i) => {
                  const maxReqs = Math.max(...metrics.topModels.map(m => m.requests), 1);
                  const pct = Math.round((mdl.requests / maxReqs) * 100);
                  const modelColor = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
                  return (
                    <div key={i} className="tud-model-row">
                      <div className="tud-model-header">
                        <span className="tud-model-rank" style={{ background: modelColor + '22', color: modelColor }}>#{i + 1}</span>
                        <span className="tud-model-name" title={mdl.name}>{mdl.name}</span>
                        <span className="tud-model-count">{mdl.requests}×</span>
                      </div>
                      <div className="tud-bar-track">
                        <div className="tud-bar-fill" style={{ width: `${pct}%`, background: modelColor }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Prompt vs Completion Split */}
          <div className="tud-chart-card tud-chart-card--split">
            <h2 className="tud-chart-title">Prompt vs Completion Tokens</h2>
            <div className="tud-donut-wrap">
              <DonutChart
                data={[
                  { label: 'Prompt', value: metrics.promptTokens, color: '#FF6B00' },
                  { label: 'Completion', value: metrics.completionTokens, color: '#FFB300' },
                ].filter(d => d.value > 0)}
                size={150}
                thickness={30}
              />
              <div className="tud-donut-legend">
                <div className="tud-legend-item">
                  <span className="tud-legend-dot" style={{ background: '#FF6B00' }} />
                  <span className="tud-legend-label">Prompt</span>
                  <span className="tud-legend-val">{fmt(metrics.promptTokens)}</span>
                </div>
                <div className="tud-legend-item">
                  <span className="tud-legend-dot" style={{ background: '#FFB300' }} />
                  <span className="tud-legend-label">Completion</span>
                  <span className="tud-legend-val">{fmt(metrics.completionTokens)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Status Breakdown */}
          <div className="tud-chart-card tud-chart-card--status">
            <h2 className="tud-chart-title">Status Breakdown</h2>
            <div className="tud-status-grid">
              {Object.entries(metrics.statusBreakdown).map(([status, count]) => (
                <div key={status} className={`tud-status-chip tud-status-${status}`}>
                  <span className="tud-status-count">{count}</span>
                  <span className="tud-status-label">{status}</span>
                </div>
              ))}
              {Object.keys(metrics.statusBreakdown).length === 0 &&
                <p className="tud-no-data">No data</p>}
            </div>
          </div>

        </section>
      )}

      {/* ── Detail Table ─────────────────────────────────────────────────── */}
      {activeView === 'table' && (
        <section className="tud-table-section">
          <div className="tud-table-info">
            Showing <strong>{filteredData.length === 0 ? 0 : Math.min((currentPage-1)*PAGE_SIZE+1, filteredData.length)}</strong>
            {' – '}
            <strong>{Math.min(currentPage*PAGE_SIZE, filteredData.length)}</strong>
            {' of '}
            <strong>{filteredData.length}</strong> records
          </div>

          {filteredData.length === 0 ? (
            <div className="tud-no-data-block">⚠️ No records match the selected filters</div>
          ) : (
            <div className="tud-table-wrap">
              <table className="tud-table">
                <thead>
                  <tr>
                    <th onClick={() => toggleSort('timestamp')} className="sortable">Timestamp{sortArrow('timestamp')}</th>
                    <th>Correlation ID</th>
                    <th onClick={() => toggleSort('llmProvider')} className="sortable">Provider{sortArrow('llmProvider')}</th>
                    <th onClick={() => toggleSort('modelName')} className="sortable">Model{sortArrow('modelName')}</th>
                    <th>Category</th>
                    <th onClick={() => toggleSort('promptTokens')} className="sortable numeric">Prompt{sortArrow('promptTokens')}</th>
                    <th onClick={() => toggleSort('completionTokens')} className="sortable numeric">Completion{sortArrow('completionTokens')}</th>
                    <th onClick={() => toggleSort('totalTokens')} className="sortable numeric">Total{sortArrow('totalTokens')}</th>
                    <th onClick={() => toggleSort('status')} className="sortable">Status{sortArrow('status')}</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedData.map((entry, idx) => (
                    <React.Fragment key={idx}>
                      <tr
                        className={`tud-tr tud-tr-${entry.status} ${expandedRow === idx ? 'tud-tr-expanded' : ''}`}
                        onClick={() => setExpandedRow(expandedRow === idx ? null : idx)}
                      >
                        <td className="tud-td-ts">{entry.timestamp}</td>
                        <td><CorrelationIDDisplay correlationID={entry.correlationId} compact={true} /></td>
                        <td>
                          {entry.llmProvider && (
                            <span className="tud-prov-chip"
                              style={{
                                background: getProviderStyle(entry.llmProvider).bg,
                                color: getProviderStyle(entry.llmProvider).text,
                                borderColor: getProviderStyle(entry.llmProvider).accent,
                              }}>
                              {entry.llmProvider}
                            </span>
                          )}
                        </td>
                        <td className="tud-td-model" title={entry.modelName}>{entry.modelName}</td>
                        <td><TokenCategoryBadge category={entry.tokenCategory} size="small" /></td>
                        <td className="numeric">{fmt(entry.promptTokens)}</td>
                        <td className="numeric">{fmt(entry.completionTokens)}</td>
                        <td className="numeric tud-total">{fmt(entry.totalTokens)}</td>
                        <td>
                          <span className={`tud-status-badge tud-status-badge-${entry.status}`}>
                            {entry.status === 'success' ? '✅' : '❌'} {entry.status}
                          </span>
                        </td>
                        <td className="tud-td-err" title={entry.errorMessage}>
                          {entry.errorMessage
                            ? entry.errorMessage.substring(0, 35) + (entry.errorMessage.length > 35 ? '…' : '')
                            : '—'}
                        </td>
                      </tr>
                      {expandedRow === idx && entry.errorMessage && (
                        <tr className="tud-expanded-row">
                          <td colSpan={10}>
                            <div className="tud-error-detail">
                              <strong>Full error message:</strong>
                              <pre>{entry.errorMessage}</pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
              <div className="tud-pagination">
                <button className="tud-page-btn" onClick={() => setCurrentPage(p => Math.max(1, p-1))} disabled={currentPage === 1}>◀ Prev</button>
                <span className="tud-page-info">Page {currentPage} of {pageCount}</span>
                <button className="tud-page-btn" onClick={() => setCurrentPage(p => Math.min(pageCount, p+1))} disabled={currentPage === pageCount}>Next ▶</button>
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="tud-footer">
        <span>📄 Source: <code>output/llm_token_usage.csv</code></span>
        <span>Auto-refreshes every 30 s</span>
      </footer>

    </div>
  );
};

export default TokenUtilizationDashboard;
