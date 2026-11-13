/**
 * CRAP report: Change Risk Anti-Patterns, per function.
 *
 *   CRAP(f) = complexity(f)² × (1 − coverage(f))³ + complexity(f)
 *
 * Complexity is cyclomatic complexity from the TypeScript AST. Coverage is the share of the function's own
 * statements that ran, from the Istanbul JSON that `vitest --coverage` writes. A function scores high if it is
 * complex and poorly tested; a fully covered function scores its complexity.
 *
 * Usage: node scripts/quality/crap.ts [--threshold 30] [--coverage coverage/coverage-final.json] [--top 10]
 * Exits non-zero if any function is over the threshold.
 */
import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { argValue, isMain } from "../../src/lib/cli.ts";

export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface FunctionInfo extends Range {
  name: string;
  complexity: number;
  /** Ranges of functions nested directly inside this one; their statements don't count towards this one. */
  nested: Range[];
}

/** The subset of Istanbul's per-file coverage that the report needs. */
export interface FileCoverage {
  statementMap: Record<string, Range>;
  s: Record<string, number>;
}

export interface CrapRow {
  file: string;
  name: string;
  line: number;
  complexity: number;
  coverage: number;
  crap: number;
}

// ---------- Complexity ----------

type AstNode = { type: string; loc?: Range | null; [key: string]: unknown };

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const BRANCH_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

const SHORT_CIRCUIT = new Set(["&&", "||", "??", "&&=", "||=", "??="]);

const SKIP_KEYS = new Set(["loc", "start", "end", "range", "extra", "leadingComments", "trailingComments", "innerComments"]);

/** How much one node adds to the complexity of the function that contains it. */
export function decisionWeight(node: AstNode): number {
  if (BRANCH_TYPES.has(node.type)) return 1;
  if (node.type === "SwitchCase") return node.test ? 1 : 0;
  if (node.type === "LogicalExpression" || node.type === "AssignmentExpression") {
    return SHORT_CIRCUIT.has(node.operator as string) ? 1 : 0;
  }
  return 0;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function childrenOf(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) out.push(...value.filter(isNode));
    else if (isNode(value)) out.push(value);
  }
  return out;
}

function keyName(key: unknown): string | null {
  if (!isNode(key)) return null;
  if (key.type === "Identifier" || key.type === "PrivateName") return (key.name as string) ?? null;
  if (key.type === "StringLiteral") return key.value as string;
  return null;
}

/** A readable name for a function node, using its parent when the function itself is anonymous. */
export function functionName(node: AstNode, parent: AstNode | null): string {
  const own = keyName(node.id) ?? keyName(node.key);
  if (own) return own;
  if (parent?.type === "VariableDeclarator") return keyName(parent.id) ?? "<anonymous>";
  if (parent?.type === "ObjectProperty" || parent?.type === "ClassProperty") return keyName(parent.key) ?? "<anonymous>";
  if (parent?.type === "CallExpression") return `<callback@${node.loc?.start.line}>`;
  return `<anonymous@${node.loc?.start.line}>`;
}

/** Every function in a source file with its cyclomatic complexity. */
export function functionComplexities(source: string): FunctionInfo[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] }) as unknown as AstNode;
  const found: FunctionInfo[] = [];

  const visit = (node: AstNode, parent: AstNode | null, owner: FunctionInfo | null) => {
    let current = owner;
    if (FUNCTION_TYPES.has(node.type) && node.loc) {
      current = { name: functionName(node, parent), start: node.loc.start, end: node.loc.end, complexity: 1, nested: [] };
      owner?.nested.push({ start: node.loc.start, end: node.loc.end });
      found.push(current);
    } else if (current) {
      current.complexity += decisionWeight(node);
    }
    for (const child of childrenOf(node)) visit(child, node, current);
  };

  visit(ast, null, null);
  return found;
}

// ---------- Coverage ----------

const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.column <= b.column);

export const within = (inner: Range, outer: Range) => before(outer.start, inner.start) && before(inner.end, outer.end);

/** Share of the function's own statements (not its nested functions') that ran. Null if it has none. */
export function functionCoverage(fn: FunctionInfo, file: FileCoverage): number | null {
  const own = Object.entries(file.statementMap).filter(
    ([, range]) => within(range, fn) && !fn.nested.some((n) => within(range, n)),
  );
  if (own.length === 0) return null;
  const hit = own.filter(([id]) => (file.s[id] ?? 0) > 0).length;
  return hit / own.length;
}

export const crapScore = (complexity: number, coverage: number) => complexity ** 2 * (1 - coverage) ** 3 + complexity;

// ---------- Report ----------

/** CRAP rows for every function in every covered file, worst first. */
export function crapReport(coverage: Record<string, FileCoverage>, readSource: (path: string) => string, root = process.cwd()): CrapRow[] {
  const rows: CrapRow[] = [];
  for (const [path, file] of Object.entries(coverage)) {
    for (const fn of functionComplexities(readSource(path))) {
      // A function with no statements of its own is an expression; treat it as covered if its parent ran.
      const cov = functionCoverage(fn, file) ?? 1;
      rows.push({ file: relative(root, path), name: fn.name, line: fn.start.line, complexity: fn.complexity, coverage: cov, crap: crapScore(fn.complexity, cov) });
    }
  }
  return rows.sort((a, b) => b.crap - a.crap);
}

export function formatRows(rows: CrapRow[]): string {
  const lines = rows.map(
    (r) => `${r.crap.toFixed(1).padStart(7)}  ${String(r.complexity).padStart(4)}  ${(r.coverage * 100).toFixed(0).padStart(4)}%  ${r.file}:${r.line} ${r.name}`,
  );
  return ["   CRAP  cplx   cov  function", ...lines].join("\n");
}

export function main(argv: readonly string[]): number {
  const threshold = Number(argValue(argv, "--threshold", "30"));
  const coveragePath = argValue(argv, "--coverage", "coverage/coverage-final.json");
  const top = Number(argValue(argv, "--top", "10"));

  const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as Record<string, FileCoverage>;
  const rows = crapReport(coverage, (p) => readFileSync(p, "utf8"));
  const failing = rows.filter((r) => r.crap > threshold);

  console.log(formatRows(rows.slice(0, top)));
  console.log(`\n${rows.length} functions; threshold ${threshold}; ${failing.length} over.`);
  if (failing.length) console.error(`\nOver threshold:\n${formatRows(failing)}`);
  return failing.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv));
