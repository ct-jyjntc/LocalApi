import assert from "node:assert/strict";
import test from "node:test";
import { isValidAdminEntryPath, normalizeAdminEntryPath } from "../src/utils/admin-entry";

test("admin entry path is normalized to one leading slash", () => {
  assert.equal(normalizeAdminEntryPath("admin"), "/admin");
  assert.equal(normalizeAdminEntryPath(" /secret-console/ "), "/secret-console");
});

test("admin entry path accepts safe private segments", () => {
  assert.equal(isValidAdminEntryPath("/admin"), true);
  assert.equal(isValidAdminEntryPath("ops_2026-console"), true);
});

test("admin entry path rejects reserved, nested and malformed paths", () => {
  assert.equal(isValidAdminEntryPath("/settings"), false);
  assert.equal(isValidAdminEntryPath("/admin/login"), false);
  assert.equal(isValidAdminEntryPath("/"), false);
  assert.equal(isValidAdminEntryPath("/管理"), false);
});
