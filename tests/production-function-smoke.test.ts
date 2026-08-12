import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { ObjectId } from "bson";
import * as mongodbDriver from "mongodb";
import productionHandler from "../api/index";
import { safeObjectId } from "../lib/db/mongodb";

const RUNTIME_OBJECT_ID_MODULES = [
  "lib/db/mongodb.ts",
  "lib/auth/session.ts",
  "lib/services/audit.service.ts",
  "lib/scans/service.ts",
  "lib/monitoring/engine.ts",
] as const;

const TYPE_ONLY_OBJECT_ID_MODULES = ["lib/auth/user.ts"] as const;

test("production handler entrypoint imports without invoking a database connection", () => {
  assert.equal(typeof productionHandler, "function");
});

test("MongoDB ObjectId runtime binding survives the release TypeScript transform", async () => {
  const bsonId = new ObjectId();
  const driverId = new mongodbDriver.ObjectId();
  assert.equal(safeObjectId(bsonId), bsonId);
  assert.equal(safeObjectId(driverId), driverId);
  assert.equal(mongodbDriver.BSON.serialize({ bsonId }).length > 0, true);
  assert.throws(() => safeObjectId("not-an-object-id"), /Invalid database identifier/);
  assert.throws(() => safeObjectId("0123456789abcdef01234567 "), /Invalid database identifier/);

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
    assert.match(emitted, /import \{ ObjectId \} from ["']bson["']/, `${relativePath} must retain the BSON runtime binding`);
    assert.match(emitted, /\bObjectId\b/, `${relativePath} must retain a bound ObjectId reference`);
    assert.doesNotMatch(emitted, /mongodbDriver\.ObjectId|\bRuntimeObjectId\b/, `${relativePath} must not emit a removed ObjectId alias`);
  }

  for (const relativePath of TYPE_ONLY_OBJECT_ID_MODULES) {
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
    assert.doesNotMatch(emitted, /\bObjectId\b|mongodbDriver/, `${relativePath} must not emit a runtime ObjectId reference`);
  }
});
