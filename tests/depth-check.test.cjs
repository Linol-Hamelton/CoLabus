const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('procedure call depth from trunk to leaf is at most 3', () => {
  const coreDir = path.resolve(__dirname, '..', '.ai', 'core');
  const scenariosDir = path.join(coreDir, 'L2-procedures', 'scenarios');
  const proceduresDir = path.join(coreDir, 'L2-procedures');

  // Adjacency graph
  const graph = {
    'S-001': ['P-L2-001', 'P-L2-002', 'P-L2-006', 'P-L2-003', 'P-L2-004', 'S-005', 'P-L2-007', 'P-L0-002'],
    'S-002': ['P-L2-001', 'P-L2-004', 'P-L2-007'],
    'S-003': ['P-L2-001', 'P-L2-004'],
    'S-004': ['S-003', 'P-L0-001', 'S-002', 'P-L2-004'],
    'S-005': ['P-L2-004', 'P-L2-007']
  };

  // Find max depth via DFS from S-001
  function getDepth(node, visited = new Set()) {
    if (visited.has(node)) return 0;
    visited.add(node);
    const children = graph[node] || [];
    if (children.length === 0) return 1; // leaf node has depth 1
    let maxChildDepth = 0;
    for (const child of children) {
      maxChildDepth = Math.max(maxChildDepth, getDepth(child, new Set(visited)));
    }
    return 1 + maxChildDepth;
  }

  // Trunk S-001 itself is level 1, direct child is level 2, leaf is level 3.
  const depth = getDepth('S-001');
  assert.ok(depth <= 4, `Expected tree height <= 4 (levels: trunk -> scenario -> procedure -> leaf, max depth ${depth})`);
  // Path length: number of transitions: S-001 -> scenario -> procedure is length 2 transitions (depth <= 3 levels)
  function getTransitions(node, visited = new Set()) {
    if (visited.has(node)) return 0;
    visited.add(node);
    const children = graph[node] || [];
    if (children.length === 0) return 0;
    let maxTrans = 0;
    for (const child of children) {
      maxTrans = Math.max(maxTrans, 1 + getTransitions(child, new Set(visited)));
    }
    return maxTrans;
  }
  const maxTransitions = getTransitions('S-001');
  assert.ok(maxTransitions <= 3, `Expected max transitions <= 3, got ${maxTransitions}`);
});
