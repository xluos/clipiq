import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";
import type { Account } from "../types";

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => ipc.listAccounts(),
  });
}

export function useUpsertAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (account: Account) => ipc.upsertAccount(account),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => ipc.deleteAccount(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}

export function useRefreshAccountProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => ipc.refreshAccountProfile(accountId),
    onSuccess: (data) => {
      if (data.ok) qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}
