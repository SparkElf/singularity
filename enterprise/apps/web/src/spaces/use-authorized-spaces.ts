import { useQuery } from "@tanstack/react-query";

import {
  authorizedSpacesQueryKey,
  getAuthorizedSpaces,
} from "@/spaces/api.ts";

export function useAuthorizedSpaces() {
  return useQuery({
    queryKey: authorizedSpacesQueryKey,
    queryFn: ({ signal }) => getAuthorizedSpaces(signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
}
