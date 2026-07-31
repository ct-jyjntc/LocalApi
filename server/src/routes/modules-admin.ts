import { Router } from "express";
import multer from "multer";
import { moduleRegistry } from "../modules/registry";

export const modulesAdminRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

modulesAdminRouter.get("/modules", (_req, res) => {
  res.json({ items: moduleRegistry.listInstalled() });
});

modulesAdminRouter.post("/modules/install", upload.single("file"), (req, res) => {
  try {
    let buffer: Buffer | null = null;
    if (req.file?.buffer) {
      buffer = req.file.buffer;
    } else if (req.body && typeof req.body.zip_base64 === "string") {
      buffer = Buffer.from(req.body.zip_base64, "base64");
    }
    if (!buffer?.length) {
      return res.status(400).json({ error: "Missing module zip (multipart file or zip_base64)" });
    }
    const activate = req.body?.activate === undefined
      ? true
      : req.body.activate === true || req.body.activate === "true" || req.body.activate === "1";
    const installed = moduleRegistry.installFromZip(buffer, { activate });
    return res.status(201).json(installed);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to install module",
    });
  }
});

modulesAdminRouter.post("/modules/:id/activate", (req, res) => {
  try {
    moduleRegistry.activate(req.params.id);
    const item = moduleRegistry.listInstalled().find((mod) => mod.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Module not found" });
    return res.json(item);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to activate module",
    });
  }
});

modulesAdminRouter.post("/modules/:id/deactivate", (req, res) => {
  try {
    moduleRegistry.deactivate(req.params.id);
    const item = moduleRegistry.listInstalled().find((mod) => mod.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Module not found" });
    return res.json(item);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to deactivate module",
    });
  }
});

modulesAdminRouter.delete("/modules/:id", (req, res) => {
  try {
    const purgeSettings = req.query.purgeSettings === "1" || req.query.purgeSettings === "true";
    moduleRegistry.uninstall(req.params.id, { purgeSettings });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to uninstall module",
    });
  }
});
