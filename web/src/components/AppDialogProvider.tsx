import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogContext, type ConfirmOptions, type PromptOptions } from "@/components/app-dialog-context";

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);
  const [promptState, setPromptState] = useState<PromptOptions | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const confirmResolve = useRef<((value: boolean) => void) | null>(null);
  const promptResolve = useRef<((value: string | null) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    confirmResolve.current?.(false);
    setConfirmState(options);
    return new Promise<boolean>((resolve) => { confirmResolve.current = resolve; });
  }, []);
  const prompt = useCallback((options: PromptOptions) => {
    promptResolve.current?.(null);
    setPromptValue(options.defaultValue || "");
    setPromptState(options);
    return new Promise<string | null>((resolve) => { promptResolve.current = resolve; });
  }, []);
  const finishConfirm = (value: boolean) => {
    confirmResolve.current?.(value);
    confirmResolve.current = null;
    setConfirmState(null);
  };
  const finishPrompt = (value: string | null) => {
    promptResolve.current?.(value);
    promptResolve.current = null;
    setPromptState(null);
  };

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      <AlertDialog open={Boolean(confirmState)} onOpenChange={(open) => { if (!open) finishConfirm(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            {confirmState?.description ? <AlertDialogDescription>{confirmState.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="secondary" onClick={() => finishConfirm(false)}>{confirmState?.cancelText || "取消"}</Button></AlertDialogCancel>
            <AlertDialogAction asChild><Button variant={confirmState?.destructive ? "destructive" : "default"} onClick={() => finishConfirm(true)}>{confirmState?.confirmText || "确认"}</Button></AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={Boolean(promptState)} onOpenChange={(open) => { if (!open) finishPrompt(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{promptState?.title}</DialogTitle>
            {promptState?.description ? <DialogDescription>{promptState.description}</DialogDescription> : null}
          </DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); const value = promptValue.trim(); if (promptState?.required && !value) return; finishPrompt(value); }}>
            <label className="flex flex-col gap-1.5">
              <Label htmlFor="app-dialog-prompt">{promptState?.label}</Label>
              <Input id="app-dialog-prompt" autoFocus value={promptValue} placeholder={promptState?.placeholder} onChange={(event) => setPromptValue(event.target.value)} />
            </label>
            <DialogFooter className="mt-0">
              <Button type="button" variant="secondary" onClick={() => finishPrompt(null)}>{promptState?.cancelText || "取消"}</Button>
              <Button type="submit" variant={promptState?.destructive ? "destructive" : "default"} disabled={Boolean(promptState?.required && !promptValue.trim())}>{promptState?.confirmText || "确认"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  );
}
