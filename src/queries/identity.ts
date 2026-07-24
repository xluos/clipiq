import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Person } from "../types";
import { ipc } from "./ipc-client";

export const IDENTITY_QUERY_KEY = ["identity-evidence"] as const;

export function useIdentityEvidence() {
  return useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: async () => {
      const [people, appearances, speakerTracks] = await Promise.all([
        ipc.listPeople(),
        ipc.listPersonAppearances(),
        ipc.listSpeakerTracks(),
      ]);
      return { people, appearances, speakerTracks };
    },
  });
}

function useIdentityMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY }),
  });
}

export function useRenamePerson() {
  return useIdentityMutation(
    ({ personId, displayName }: { personId: string; displayName?: string }) =>
      ipc.renamePerson(personId, displayName),
  );
}

export function useMergePeople() {
  return useIdentityMutation(
    ({ sourcePersonId, targetPersonId }: {
      sourcePersonId: string;
      targetPersonId: string;
    }) => ipc.mergePeople(sourcePersonId, targetPersonId),
  );
}

export function useSplitPersonAppearance() {
  return useIdentityMutation(
    ({ appearanceId, person }: { appearanceId: string; person: Person }) =>
      ipc.splitPersonAppearance(appearanceId, person),
  );
}

export function useLinkSpeakerTrackPerson() {
  return useIdentityMutation(
    ({ speakerTrackId, personId }: {
      speakerTrackId: string;
      personId?: string;
    }) => ipc.linkSpeakerTrackPerson(speakerTrackId, personId),
  );
}
