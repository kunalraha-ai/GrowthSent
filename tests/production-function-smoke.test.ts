import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as mongodbDriver from "mongodb";
import productionHandler from "../api/index";
import { safeObjectId } from "../lib/db/mongodb";

const RUNTIME_OBJECT_ID_MODULES = [
  "lib/db/mongodb.ts",
  "lib/auth/session.ts",
  "lib/auth/user.ts",
  "lib/services/audit.service.ts",
  "lib/scans/service.ts",
  "lib/monitoring/engine.ts",
] as const;

test("production handler entrypoint imports without invoking a database connection", () => {
  assert.equal(typeof productionHandler, "function");
});

test("MongoDB ObjectId runtime binding survives the release TypeScript transform", async () => {
  const id = new mongodbDriver.ObjectId();
  assert.equal(safeObjectId(id), id);

  for (const relativePath of RUNTIME_OBJECT_ID_MODULES) {
    const source = await readFile(relativePath, "utf8");
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        removeComments: true,
      },
      fileName: relativePath,
    }).outputText;
    assert.match(emitted, /mongodbDriver\.ObjectId/, `${relativePath} must retain a namespace ObjectId reference`);
    assert.match(emitted, /import \* as mongodbDriver from ["']mongodb["']/, `${relativePath} must retain the runtime MongoDB binding`);
    assert.doesNotMatch(emitted, /(?<!\.)\bRuntimeObjectId\b|(?<!\.)\bObjectId\b/, `${relativePath} must not emit an unbound ObjectId identifier`);
  }
});
