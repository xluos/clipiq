import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";

type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmDialogProvider");
  return ctx;
}

type Pending = ConfirmOptions & { resolve: (v: boolean) => void };

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending({ ...options, resolve });
    });
  }, []);

  const handleAnswer = useCallback((value: boolean) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    if (r) r(value);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <DialogPrimitive.Root
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) handleAnswer(false);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[100] bg-black/30 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Popup
            className="fixed left-1/2 top-1/2 z-[101] grid w-full max-w-sm -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] p-5 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            {pending && (
              <>
                <DialogPrimitive.Title className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {pending.title}
                </DialogPrimitive.Title>
                {pending.description && (
                  <DialogPrimitive.Description className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    {pending.description}
                  </DialogPrimitive.Description>
                )}
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="outline" size="sm" onClick={() => handleAnswer(false)}>
                    {pending.cancelLabel || "取消"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleAnswer(true)}
                    className={
                      pending.destructive
                        ? "bg-red-500 hover:bg-red-600 text-white border-red-500"
                        : ""
                    }
                  >
                    {pending.confirmLabel || "确定"}
                  </Button>
                </div>
              </>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </ConfirmContext.Provider>
  );
}
