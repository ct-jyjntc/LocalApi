import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

test("module registry can install, activate, deactivate, and uninstall a zip module", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-modules-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "modules-test-secret";

  const { db, initDb, getSetting } = await import("../src/db");
  const { getPaymentProvider } = await import("../src/services/payment-providers");
  const { getAuthProvider } = await import("../src/services/auth-providers");
  const { moduleRegistry } = await import("../src/modules/registry");

  try {
    initDb();

    const bundledCandidates = [
      path.resolve(__dirname, "../bundled-modules/linuxdo"),
      path.resolve(__dirname, "../../server/bundled-modules/linuxdo"),
      path.resolve(process.cwd(), "bundled-modules/linuxdo"),
      path.resolve(process.cwd(), "server/bundled-modules/linuxdo"),
    ];
    const bundled = bundledCandidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "module.json")),
    );
    assert.ok(bundled, "bundled linuxdo module missing — run npm run package:linuxdo");

    const zip = new AdmZip();
    for (const name of fs.readdirSync(bundled)) {
      const full = path.join(bundled, name);
      if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, name);
      else zip.addLocalFile(full);
    }
    const zipBuffer = zip.toBuffer();

    const installed = moduleRegistry.installFromZip(zipBuffer, { activate: true });
    assert.equal(installed.id, "linuxdo");
    assert.equal(installed.active, true);
    assert.ok(installed.features.includes("auth.linuxdo"));
    assert.ok(getPaymentProvider("linuxdo_credit"));
    assert.ok(getAuthProvider("linuxdo"));
    assert.ok(
      db.prepare("SELECT id FROM payment_channels WHERE id = 'linuxdo-credit'").get(),
    );

    moduleRegistry.deactivate("linuxdo");
    assert.equal(getPaymentProvider("linuxdo_credit"), null);
    assert.equal(getAuthProvider("linuxdo"), null);
    const afterDeactivate = moduleRegistry.listInstalled().find((item) => item.id === "linuxdo");
    assert.equal(afterDeactivate?.enabled, false);
    assert.equal(afterDeactivate?.active, false);

    moduleRegistry.activate("linuxdo");
    assert.ok(getPaymentProvider("linuxdo_credit"));

    moduleRegistry.uninstall("linuxdo", { purgeSettings: true });
    assert.equal(moduleRegistry.listInstalled().length, 0);
    assert.equal(getPaymentProvider("linuxdo_credit"), null);
    assert.equal(getSetting("linuxdo_client_id"), null);
    assert.ok(
      !fs.existsSync(path.join(dir, "modules", "linuxdo")),
      "module files should be removed",
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
