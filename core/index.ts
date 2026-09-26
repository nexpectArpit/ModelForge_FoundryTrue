/**
 * ModelForge Core — Barrel Export
 *
 * Organized by architectural layer:
 *   1. Domain types & errors
 *   2. Port interfaces
 *   3. State management
 *   4. Domain services
 *   5. Infrastructure adapters
 *   6. MCP boundary
 */

// Layer 1: Domain contracts & error taxonomy
export * from './types.js';
export * from './errors.js';

// Layer 2: Port interfaces (hexagonal architecture)
export * from './ports.js';

// Layer 3: State management
export * from './state-machine.js';
export * from './session-registry.js';

// Layer 4: Domain services
export * from './orchestrator.js';
export * from './repository-analyzer.js';
export * from './evaluation-engine.js';
export * from './failure-diagnostician.js';
export * from './failure-pattern-registry.js';
export * from './migration-planner.js';
export * from './model-capabilities.js';
export * from './approval-token.js';

// Layer 5: Infrastructure adapters
export * from './workspace-sandbox.js';
export * from './patching-engine.js';

// Layer 6: MCP boundary
export * from './mcp-boundary.js';

// Layer 7: Rehearsal differential comparison
export * from './rehearsal/index.js';

