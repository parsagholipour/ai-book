import { useCallback, useState } from "react";

export function useBusyActions() {
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});

  const isActionBusy = useCallback((key: string): boolean => Boolean(busyActions[key]), [busyActions]);

  const runBusyAction = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusyActions((current) => ({ ...current, [key]: true }));
    try {
      await action();
    } finally {
      setBusyActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }, []);

  return { busyActions, isActionBusy, runBusyAction };
}
