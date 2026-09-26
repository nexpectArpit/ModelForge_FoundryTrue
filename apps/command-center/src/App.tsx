import React, { useState } from 'react';
import './styles.css';

export function App() {
  const [approvalStatus, setApprovalStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');

  const timelineEvents = [
    { time: '14:02:01', label: 'TrueForge Session Created', detail: 'Session ID: ses-9841-rehearsal' },
    { time: '14:02:04', label: 'Code Inspector Subagent', detail: 'Found 12 model couplings across config.ts and agent.ts' },
    { time: '14:02:12', label: 'Sandbox Mounted', detail: 'customer-support-app online at :8955' },
    { time: '14:02:18', label: 'Round 1 Benchmark', detail: '11/15 Passed. Tool calling schema validation FAILED' },
    { time: '14:02:29', label: 'Diagnostician Subagent', detail: 'Identified argument regression; synthesized Hybrid Router' },
    { time: '14:02:41', label: 'Round 2 Benchmark', detail: '15/15 Passed. Quality: 1.00, Latency: 65ms, Cost: -93%' },
    { time: '14:02:50', label: 'Approval Required', detail: 'apply_production_routing paused at TrueForge gate' },
  ];

  return (
    <div className="command-room">
      <header className="top-nav">
        <div className="brand">
          <span className="brand-badge">TRUEFORGE</span>
          <span className="brand-title">MODELFORGE // Safe AI Model Migration Rehearsal</span>
        </div>
        <div className="status-badge">
          <span className={`status-dot ${approvalStatus === 'approved' ? 'active' : ''}`}></span>
          <span>{approvalStatus === 'approved' ? 'CANARY ACTIVE (LIVE)' : 'APPROVAL GATE PENDING'}</span>
        </div>
      </header>

      <div className="dashboard-grid">
        {/* Sidebar: Event Stream */}
        <aside className="timeline-pane">
          <div className="pane-title">TrueForge SSE Execution Stream</div>
          <div className="timeline-feed">
            {timelineEvents.map((ev, idx) => (
              <div key={idx} className="timeline-item">
                <span className="timeline-time">{ev.time}</span>
                <div className="timeline-content">
                  <strong>{ev.label}</strong>
                  <div>{ev.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Main Stage */}
        <main className="main-stage">
          {/* Target Info */}
          <div className="config-strip">
            <div className="config-item">
              <span className="config-label">Target Application</span>
              <span className="config-value">customer-support-app</span>
            </div>
            <div className="config-item">
              <span className="config-label">Baseline Model</span>
              <span className="config-value">openai/gpt-4o</span>
            </div>
            <div className="config-item">
              <span className="config-label">Candidate Model</span>
              <span className="config-value">openai/gpt-4o-mini</span>
            </div>
            <div className="config-item">
              <span className="config-label">Remediation Architecture</span>
              <span className="config-value">Hybrid Task Routing</span>
            </div>
          </div>

          {/* Benchmark Matrix */}
          <div className="matrix-card">
            <div className="matrix-header">
              <div className="pane-title">Deterministic Benchmark Comparison Matrix (15 Cases)</div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Suite ID: eval-support-v1</span>
            </div>
            <table className="matrix-table">
              <thead>
                <tr>
                  <th>Phase</th>
                  <th>Quality Score</th>
                  <th>p95 Latency</th>
                  <th>Cost / 1k Req</th>
                  <th>Regressions Observed</th>
                  <th>Authoritative Verdict</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Round 1 (Naive Model B)</strong></td>
                  <td>0.73 (Threshold: 0.90)</td>
                  <td>19ms</td>
                  <td>$0.02 (-98.9%)</td>
                  <td style={{ color: 'var(--accent-red)' }}>4 tool calling schema failures</td>
                  <td><span className="verdict-fail">FAIL</span></td>
                </tr>
                <tr>
                  <td><strong>Round 2 (Hybrid Router)</strong></td>
                  <td>1.00 (Threshold: 0.90)</td>
                  <td>65ms</td>
                  <td>$0.13 (-93.0%)</td>
                  <td style={{ color: 'var(--accent-emerald)' }}>Zero regressions (15/15 passed)</td>
                  <td><span className="verdict-pass">PASS</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Approval Gate */}
          {approvalStatus === 'pending' && (
            <div className="approval-card">
              <div className="approval-header">
                <div className="approval-title">
                  <span>⚠️</span>
                  <span>TRUEFORGE NATIVE TOOL APPROVAL GATE // apply_production_routing</span>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accent-amber)' }}>
                  State: tool.approval_required
                </span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                The agent has successfully proven candidate viability in the isolated sandbox.
                It is proposing a <strong>10% canary traffic allocation</strong> to the Hybrid Router.
                Production mutation is strictly paused pending operator authorization.
              </p>
              <div className="approval-actions">
                <button
                  className="btn btn-approve"
                  onClick={() => setApprovalStatus('approved')}
                >
                  ✓ AUTHORIZE CANARY ROLLOUT
                </button>
                <button
                  className="btn btn-reject"
                  onClick={() => setApprovalStatus('rejected')}
                >
                  ✕ REJECT MUTATION
                </button>
              </div>
            </div>
          )}

          {/* Verification Badge */}
          {approvalStatus === 'approved' && (
            <div className="verification-card">
              <div>
                <strong style={{ color: 'var(--accent-emerald)', display: 'block', marginBottom: '0.25rem' }}>
                  ✓ PRODUCTION ROUTING MUTATION VERIFIED
                </strong>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  Live Gateway Table: 90% Model A (Baseline) | 10% Model B (Hybrid Canary)
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="config-label" style={{ display: 'block', marginBottom: '0.2rem' }}>Cryptographic Routing SHA</span>
                <span className="sha-code">73446e7dbbaa4be0</span>
              </div>
            </div>
          )}

          {approvalStatus === 'rejected' && (
            <div className="verification-card" style={{ borderColor: 'var(--accent-red)' }}>
              <div>
                <strong style={{ color: 'var(--accent-red)', display: 'block', marginBottom: '0.25rem' }}>
                  ✕ PRODUCTION MUTATION REJECTED BY OPERATOR
                </strong>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  Migration rehearsal safely aborted. Production gateway remains 100% on Model A baseline.
                </span>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
