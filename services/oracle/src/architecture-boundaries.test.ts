import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
const pathName = (file: string) => relative(sourceRoot, file).replaceAll("\\", "/");
const productionFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? productionFiles(file)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [file] : [];
  });

interface Dependency { specifier: string; line: number }
interface Source { file: string; dependencies: Dependency[]; runtimeViolations: string[] }

function qualifiedName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const object = qualifiedName(node.expression);
    return object === undefined ? undefined : `${object}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const object = qualifiedName(node.expression);
    return object === undefined ? undefined : `${object}.${node.argumentExpression.text}`;
  }
  return undefined;
}

function inspect(file: string, text = readFileSync(file, "utf8")): Source {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dependencies: Dependency[] = [];
  const runtimeViolations: string[] = [];
  const lineAt = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const dependency = (argument: ts.Node | undefined, owner: ts.Node) => {
    dependencies.push({ specifier: argument !== undefined && ts.isStringLiteralLike(argument)
      ? argument.text : "<computed-module>", line: lineAt(owner) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) dependency(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      dependency(node.moduleReference.expression, node);
    } else if (ts.isImportTypeNode(node)) {
      dependency(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      dependency(node.arguments[0], node);
    }
    const name = qualifiedName(node);
    if (name === "process.env" || name === "globalThis.process.env") {
      runtimeViolations.push(`${lineAt(node)}: direct environment access`);
    }
    if (name === "Date.now" || name === "globalThis.Date.now" || name === "performance.now" || name === "globalThis.performance.now") {
      runtimeViolations.push(`${lineAt(node)}: implicit runtime clock`);
    }
    if (ts.isNewExpression(node) && ["Date", "globalThis.Date"].includes(qualifiedName(node.expression) ?? "") &&
      (node.arguments === undefined || node.arguments.length === 0)) {
      runtimeViolations.push(`${lineAt(node)}: current Date constructor`);
    }
    if (ts.isCallExpression(node) && ["Date", "globalThis.Date", "fetch", "globalThis.fetch"].includes(qualifiedName(node.expression) ?? "")) {
      runtimeViolations.push(`${lineAt(node)}: implicit runtime I/O or clock`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, dependencies, runtimeViolations };
}

function internalTarget(file: string, specifier: string, sources: Map<string, Source>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
  return [target, `${target}.ts`, resolve(target, "index.ts")].find(candidate => sources.has(candidate));
}

function inwardViolations(source: Source, sources: Map<string, Source>, layer: "domain" | "application"): string[] {
  const allowedExternal = layer === "domain"
    ? new Set(["@terravoce/protocol", "zod", "node:crypto"])
    : new Set(["@terravoce/protocol", "zod"]);
  return source.dependencies.flatMap(({ specifier, line }) => {
    const target = internalTarget(source.file, specifier, sources);
    const allowed = target === undefined ? allowedExternal.has(specifier)
      : pathName(target).startsWith("domain/") || layer === "application" && pathName(target).startsWith("application/");
    return allowed ? [] : [`${pathName(source.file)}:${line}: ${specifier}`];
  });
}

function httpViolations(file: string, sources: Map<string, Source>, visited = new Set<string>()): string[] {
  if (visited.has(file)) return [];
  visited.add(file);
  const source = sources.get(file)!;
  return source.dependencies.flatMap(({ specifier, line }) => {
    const target = internalTarget(file, specifier, sources);
    if (specifier === "pg" || specifier === "@terravoce/terralex" || target !== undefined &&
      (pathName(target).startsWith("adapters/persistence/") || pathName(target).startsWith("adapters/policy/"))) {
      return [`${pathName(file)}:${line}: HTTP dependency reaches ${specifier}`];
    }
    return target === undefined ? [] : httpViolations(target, sources, visited);
  });
}

describe("Oracle production architecture boundaries", () => {
  it("keeps every domain production import inward, including type imports and re-exports", () => {
    const sources = new Map(productionFiles(sourceRoot).map(file => [file, inspect(file)]));
    const domain = [...sources.values()].filter(source => pathName(source.file).startsWith("domain/"));
    expect(domain.length).toBeGreaterThan(0);
    expect(domain.flatMap(source => inwardViolations(source, sources, "domain"))).toEqual([]);
  });

  it("keeps application use cases dependent on ports and domain without runtime adapters, environment or a real clock", () => {
    const sources = new Map(productionFiles(sourceRoot).map(file => [file, inspect(file)]));
    const application = [...sources.values()].filter(source => pathName(source.file).startsWith("application/"));
    expect(application.some(source => pathName(source.file) === "application/use-cases.ts")).toBe(true);
    expect(application.flatMap(source => inwardViolations(source, sources, "application"))).toEqual([]);
    expect(application.flatMap(source => source.runtimeViolations.map(violation => `${pathName(source.file)}:${violation}`))).toEqual([]);
  });

  it("does not let HTTP adapters reach persistence or policy adapters through compatibility facades", () => {
    const sources = new Map(productionFiles(sourceRoot).map(file => [file, inspect(file)]));
    const http = [...sources.keys()].filter(file => pathName(file).startsWith("adapters/http/"));
    expect(http.length).toBeGreaterThan(0);
    expect(http.flatMap(file => httpViolations(file, sources))).toEqual([]);
  });

  it("recognizes prohibited dependencies in AST syntax while ignoring text inside comments", () => {
    const file = resolve(sourceRoot, "application/synthetic-boundary-probe.ts");
    const probe = inspect(file, `
      // import ignored from "pg";
      import type { Pool as Database } from "pg";
      export * from "@terravoce/terralex";
      type Escaped = import("node:fs").Stats;
      const load = () => import("fastify");
      const dynamic = (name: string) => import(name);
      const zone = process["env"].TZ;
      const clock = Date.now;
      const current = new Date();
      const parsed = Date.parse("2026-10-22T00:00:00Z");
    `);
    expect(probe.dependencies.map(dependency => dependency.specifier)).toEqual([
      "pg", "@terravoce/terralex", "node:fs", "fastify", "<computed-module>"
    ]);
    expect(inwardViolations(probe, new Map([[file, probe]]), "application")).toHaveLength(5);
    expect(probe.runtimeViolations).toHaveLength(3);
  });
});
