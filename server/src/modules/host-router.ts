import { Router, type RequestHandler } from "express";

type Mountable = Router | RequestHandler;

/**
 * Parent Express router that can attach/detach child routers by module id.
 * Detach filters the Express layer stack so routes disappear immediately.
 */
export class ModuleHostRouter {
  readonly router = Router();
  private readonly mounts = new Map<string, Mountable>();

  attach(moduleId: string, child: Mountable) {
    this.detach(moduleId);
    this.mounts.set(moduleId, child);
    this.router.use(child);
  }

  detach(moduleId: string) {
    const child = this.mounts.get(moduleId);
    if (!child) return;
    this.mounts.delete(moduleId);
    const stack = (this.router as unknown as { stack?: Array<{ handle?: unknown }> }).stack;
    if (!Array.isArray(stack)) return;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]?.handle === child) {
        stack.splice(i, 1);
      }
    }
  }

  has(moduleId: string) {
    return this.mounts.has(moduleId);
  }

  clear() {
    for (const id of [...this.mounts.keys()]) {
      this.detach(id);
    }
  }
}
