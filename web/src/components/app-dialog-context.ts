import { createContext, useContext } from "react";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

export type PromptOptions = ConfirmOptions & {
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
};

export type DialogApi = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

export const DialogContext = createContext<DialogApi | null>(null);

export function useAppDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error("useAppDialog must be used inside AppDialogProvider");
  return value;
}
