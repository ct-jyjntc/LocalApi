import { useQuery } from "@tanstack/react-query";
import { api, type PublicModule } from "@/lib/api";

export function usePublicModules() {
  return useQuery({
    queryKey: ["modules-public"],
    queryFn: () => api.modules.public(),
    staleTime: 30_000,
  });
}

export function hasModuleFeature(
  modules: PublicModule[] | undefined,
  feature: string,
) {
  return Boolean(modules?.some((mod) => mod.enabled && mod.features.includes(feature)));
}

export function isModuleActive(modules: PublicModule[] | undefined, id: string) {
  return Boolean(modules?.some((mod) => mod.id === id && mod.enabled));
}
