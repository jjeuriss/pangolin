import { build } from "@server/build";
import type { ListClientsResponse } from "@server/routers/client";
import type { ListRolesResponse } from "@server/routers/role";
import type { ListSitesResponse } from "@server/routers/site";
import type {
    ListSiteResourceClientsResponse,
    ListSiteResourceRolesResponse,
    ListSiteResourceUsersResponse
} from "@server/routers/siteResource";
import type { ListUsersResponse } from "@server/routers/user";
import type ResponseT from "@server/types/Response";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { AxiosInstance, AxiosResponse } from "axios";
import z from "zod";
import { remote } from "./api";
import { durationToMs } from "./durationToMs";
import type { QueryRequestAnalyticsResponse } from "@server/routers/auditLogs";
import type {
    GetResourceWhitelistResponse,
    ListResourceNamesResponse
} from "@server/routers/resource";
import type { ListTargetsResponse } from "@server/routers/target";
import type { ListDomainsResponse } from "@server/routers/domain";

export type ProductUpdate = {
    link: string | null;
    build: "enterprise" | "oss" | "saas" | null;
    id: number;
    type: "Update" | "Important" | "New" | "Warning";
    title: string;
    contents: string;
    publishedAt: Date;
    showUntil: Date;
};

export type LatestVersionResponse = {
    pangolin: {
        latestVersion: string;
        releaseNotes: string;
    };
};

export const productUpdatesQueries = {
    list: (enabled: boolean, version?: string) =>
        queryOptions({
            queryKey: ["PRODUCT_UPDATES"] as const,
            queryFn: async ({ signal }) => {
                const sp = new URLSearchParams({
                    build,
                    ...(version ? { version } : {})
                });
                const data = await remote.get<ResponseT<ProductUpdate[]>>(
                    `/product-updates?${sp.toString()}`,
                    { signal }
                );
                return data.data;
            },
            refetchInterval: (query) => {
                if (query.state.data) {
                    return durationToMs(5, "minutes");
                }
                return false;
            },
            enabled
        }),
    latestVersion: (enabled: boolean) =>
        queryOptions({
            queryKey: ["LATEST_VERSION"] as const,
            queryFn: async ({ signal }) => {
                const data = await remote.get<ResponseT<LatestVersionResponse>>(
                    "/versions",
                    { signal }
                );
                return data.data;
            },
            placeholderData: keepPreviousData,
            refetchInterval: (query) => {
                if (query.state.data) {
                    return durationToMs(30, "minutes");
                }
                return false;
            },
            enabled: enabled && build !== "saas" // disabled in cloud version
            // because we don't need to listen for new versions there
        })
};

export const clientFilterSchema = z.object({
    filter: z.enum(["machine", "user"]),
    limit: z.int().prefault(1000).optional()
});

export const orgQueries = {
    clients: ({
        orgId,
        filters
    }: {
        orgId: string;
        filters: z.infer<typeof clientFilterSchema>;
    }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "CLIENTS", filters] as const,
            queryFn: async ({ signal, meta }) => {
                const sp = new URLSearchParams({
                    ...filters,
                    limit: (filters.limit ?? 1000).toString()
                });

                const res = await meta!.api.get<
                    AxiosResponse<ListClientsResponse>
                >(`/org/${orgId}/clients?${sp.toString()}`, { signal });

                return res.data.data.clients;
            }
        }),
    users: ({ orgId }: { orgId: string }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "USERS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListUsersResponse>
                >(`/org/${orgId}/users`, { signal });

                return res.data.data.users;
            }
        }),
    roles: ({ orgId }: { orgId: string }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "ROLES"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListRolesResponse>
                >(`/org/${orgId}/roles`, { signal });

                return res.data.data.roles;
            }
        }),

    sites: ({ orgId }: { orgId: string }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "SITES"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSitesResponse>
                >(`/org/${orgId}/sites`, { signal });
                return res.data.data.sites;
            }
        }),

    domains: ({ orgId }: { orgId: string }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "DOMAINS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListDomainsResponse>
                >(`/org/${orgId}/domains`, { signal });
                return res.data.data.domains;
            }
        }),
    identityProviders: ({ orgId }: { orgId: string }) =>
        queryOptions({
            queryKey: ["ORG", orgId, "IDPS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<{
                        idps: { idpId: number; name: string }[];
                    }>
                >(build === "saas" ? `/org/${orgId}/idp` : "/idp", { signal });
                return res.data.data.idps;
            }
        })
};

export const logAnalyticsFiltersSchema = z.object({
    timeStart: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), {
            error: "timeStart must be a valid ISO date string"
        })
        .optional(),
    timeEnd: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), {
            error: "timeEnd must be a valid ISO date string"
        })
        .optional(),
    resourceId: z
        .string()
        .optional()
        .transform(Number)
        .pipe(z.int().positive())
        .optional()
});

export type LogAnalyticsFilters = z.TypeOf<typeof logAnalyticsFiltersSchema>;

export const logQueries = {
    requestAnalytics: ({
        orgId,
        filters
    }: {
        orgId: string;
        filters: LogAnalyticsFilters;
    }) =>
        queryOptions({
            queryKey: ["REQUEST_LOG_ANALYTICS", orgId, filters] as const,
            queryFn: async ({ signal, meta }) => {
                console.log("[ANALYTICS] Fetching request analytics - auto-refetch DISABLED (code v2)");
                const res = await meta!.api.get<
                    AxiosResponse<QueryRequestAnalyticsResponse>
                >(`/org/${orgId}/logs/analytics`, {
                    params: filters,
                    signal
                });
                return res.data.data;
            },
            // Disabled automatic refetch - analytics queries are heavy and scan large tables
            // Use manual refresh button instead to avoid 197GB+ disk reads over time
            refetchInterval: false
        })
};

export const resourceQueries = {
    resourceUsers: ({ resourceId }: { resourceId: number }) =>
        queryOptions({
            queryKey: ["RESOURCES", resourceId, "USERS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSiteResourceUsersResponse>
                >(`/resource/${resourceId}/users`, { signal });
                return res.data.data.users;
            }
        }),
    resourceRoles: ({ resourceId }: { resourceId: number }) =>
        queryOptions({
            queryKey: ["RESOURCES", resourceId, "ROLES"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSiteResourceRolesResponse>
                >(`/resource/${resourceId}/roles`, { signal });

                return res.data.data.roles;
            }
        }),
    siteResourceUsers: ({ siteResourceId }: { siteResourceId: number }) =>
        queryOptions({
            queryKey: ["SITE_RESOURCES", siteResourceId, "USERS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSiteResourceUsersResponse>
                >(`/site-resource/${siteResourceId}/users`, { signal });
                return res.data.data.users;
            }
        }),
    siteResourceRoles: ({ siteResourceId }: { siteResourceId: number }) =>
        queryOptions({
            queryKey: ["SITE_RESOURCES", siteResourceId, "ROLES"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSiteResourceRolesResponse>
                >(`/site-resource/${siteResourceId}/roles`, { signal });

                return res.data.data.roles;
            }
        }),
    siteResourceClients: ({ siteResourceId }: { siteResourceId: number }) =>
        queryOptions({
            queryKey: ["SITE_RESOURCES", siteResourceId, "CLIENTS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListSiteResourceClientsResponse>
                >(`/site-resource/${siteResourceId}/clients`, { signal });

                return res.data.data.clients;
            }
        }),
    resourceTargets: ({ resourceId }: { resourceId: number }) =>
        queryOptions({
            queryKey: ["RESOURCES", resourceId, "TARGETS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListTargetsResponse>
                >(`/resource/${resourceId}/targets`, { signal });

                return res.data.data.targets;
            }
        }),
    resourceWhitelist: ({ resourceId }: { resourceId: number }) =>
        queryOptions({
            queryKey: ["RESOURCES", resourceId, "WHITELISTS"] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<GetResourceWhitelistResponse>
                >(`/resource/${resourceId}/whitelist`, { signal });

                return res.data.data.whitelist;
            }
        }),
    listNamesPerOrg: (orgId: string) =>
        queryOptions({
            queryKey: ["RESOURCES_NAMES", orgId] as const,
            queryFn: async ({ signal, meta }) => {
                const res = await meta!.api.get<
                    AxiosResponse<ListResourceNamesResponse>
                >(`/org/${orgId}/resource-names`, {
                    signal
                });
                return res.data.data;
            }
        })
};
