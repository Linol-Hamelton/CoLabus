'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, tt } = require('./helpers.cjs');

const CORE_DIR = path.join(repoRoot, '.ai', 'core');
const SCENARIOS_DIR = path.join(CORE_DIR, 'L2-procedures', 'scenarios');
const PROCEDURE_DIRS = [
  path.join(CORE_DIR, 'L2-procedures'),
  path.join(CORE_DIR, 'L0-meta'),
];
const TRUNK = 'S-001';
// S3-T10: trunk -> scenario -> procedure -> leaf.
const MAX_LEVELS = 4;
const MAX_TRANSITIONS = 3;

// The call graph is read from the scenario records themselves: every
// S-xxx / P-Lx-xxx token a scenario names is a call edge (step tables,
// stage graphs, handoff artifacts and back edges all name the procedures
// and sub-scenarios the scenario invokes). Nothing is hardcoded here.
function buildGraph(scenariosDir, procedureDirs) {
  const files = fs.readdirSync(scenariosDir)
    .filter(f => /^S-\d{3}.*\.md$/.test(f))
    .sort();
  assert.ok(files.length >= 2, 'scenarios directory must hold the scenario records');
  const graph = {};
  for (const file of files) {
    const text = fs.readFileSync(path.join(scenariosDir, file), 'utf8');
    const id = (text.match(/^id:\s*(S-\d{3})\s*$/m) || [])[1];
    assert.ok(id, `${file} must declare its scenario id in front matter`);
    const edges = new Set();
    for (const m of text.matchAll(/\b[SP]-(?:L\d-)?\d{3}\b/g)) edges.add(m[0]);
    edges.delete(id);
    graph[id] = [...edges].sort();
  }
  // Every referenced node must resolve: a scenario to a record in
  // scenarios/, a procedure to a record file in a procedure directory.
  for (const [node, edges] of Object.entries(graph)) {
    for (const edge of edges) {
      if (edge.startsWith('S-')) {
        assert.ok(graph[edge], `${node} calls ${edge}, which has no record in scenarios/`);
      } else {
        const found = procedureDirs.some(dir =>
          fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.startsWith(edge + '-') && f.endsWith('.md')));
        assert.ok(found, `${node} calls ${edge}, which has no record file`);
      }
    }
  }
  return graph;
}

// Node depth: the root is level 1, a direct child is level 2, a leaf is
// its own level. Cycles cut the path (a node already on the path adds 0).
function maxDepth(graph, node, visited = new Set()) {
  if (visited.has(node)) return 0;
  visited.add(node);
  const children = graph[node] || [];
  let best = 0;
  for (const child of children) {
    best = Math.max(best, maxDepth(graph, child, new Set(visited)));
  }
  return 1 + best;
}

// Path length in transitions (edges): root -> scenario -> procedure is 2.
function maxTransitions(graph, node, visited = new Set()) {
  if (visited.has(node)) return 0;
  visited.add(node);
  const children = graph[node] || [];
  let best = 0;
  for (const child of children) {
    best = Math.max(best, 1 + maxTransitions(graph, child, new Set(visited)));
  }
  return best;
}

test('procedure call depth from trunk to leaf is at most 3', () => {
  const graph = buildGraph(SCENARIOS_DIR, PROCEDURE_DIRS);

  assert.ok(graph[TRUNK], `trunk scenario ${TRUNK} must exist`);
  // Trunk contract anchors (S-001 stage graph): the trunk calls the fix
  // round, the budget audit and acceptance. A graph that lost these edges
  // is not the trunk graph, whatever the depth math says.
  assert.ok(graph[TRUNK].includes('S-005'), 'trunk must call the fix round S-005');
  assert.ok(graph[TRUNK].includes('P-L2-007'), 'trunk must call the budget audit P-L2-007');
  assert.ok(graph[TRUNK].includes('P-L2-004'), 'trunk must call acceptance P-L2-004');

  const depth = maxDepth(graph, TRUNK);
  assert.ok(depth <= MAX_LEVELS,
    `Expected tree height <= ${MAX_LEVELS} (levels: trunk -> scenario -> procedure -> leaf), got ${depth}`);
  const transitions = maxTransitions(graph, TRUNK);
  assert.ok(transitions <= MAX_TRANSITIONS,
    `Expected max transitions <= ${MAX_TRANSITIONS}, got ${transitions}`);
});

test('S3-T10 mutant: an extra real call edge that adds depth is detected', t => {
  const fixture = tt.mkTmp('depth-check-mutant-', t);
  const scenariosDir = path.join(fixture, 'scenarios');
  fs.mkdirSync(scenariosDir, { recursive: true });
  for (const file of fs.readdirSync(SCENARIOS_DIR)) {
    fs.copyFileSync(path.join(SCENARIOS_DIR, file), path.join(scenariosDir, file));
  }
  // Mutant: the fix round S-005 starts calling the kernel patch cycle
  // S-004, which chains through S-002/S-003 and pushes the path past the
  // S3-T10 budget. Applied to a copy of the real records only.
  const s005 = path.join(scenariosDir, 'S-005-fix-round.md');
  const original = fs.readFileSync(s005, 'utf8');
  assert.ok(!/\bS-004\b/.test(original), 'precondition: S-005 must not call S-004 today');
  fs.writeFileSync(s005, original + '\nEscalation continues per S-004.\n');

  const graph = buildGraph(scenariosDir, PROCEDURE_DIRS);
  assert.ok(graph['S-005'].includes('S-004'), 'mutant edge S-005 -> S-004 must be in the graph');
  const depth = maxDepth(graph, TRUNK);
  assert.ok(depth > MAX_LEVELS,
    `mutant depth ${depth} must exceed the limit ${MAX_LEVELS} (the main assertion would fail)`);
  const transitions = maxTransitions(graph, TRUNK);
  assert.ok(transitions > MAX_TRANSITIONS,
    `mutant transitions ${transitions} must exceed the limit ${MAX_TRANSITIONS}`);
});
