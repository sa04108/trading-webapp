import { useQuery } from "@tanstack/react-query";
import { isFinishedJob, type JobFilter, type JobResponse, type JobsResponse } from "@shared/schemas/jobs";
import { api, ApiError } from "@/lib/api-client";

const cannotRefresh = (error: Error | null) => error instanceof ApiError && [401, 403, 404].includes(error.status);
const retry = (count: number, error: Error) => count < 1 && !cannotRefresh(error);

export function useJobs(status: JobFilter, offset: number) {
  return useQuery({
    queryKey: ["jobs", "list", status, offset],
    queryFn: ({ signal }) => api<JobsResponse>(`/jobs?status=${status}&limit=50&offset=${offset}`, { signal }),
    refetchInterval: (query) => cannotRefresh(query.state.error) ? false : query.state.error ? 30_000 : query.state.data?.activeCount ? 5_000 : 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry,
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: ["jobs", "detail", id],
    queryFn: ({ signal }) => api<JobResponse>(`/jobs/${encodeURIComponent(id)}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: (query) => cannotRefresh(query.state.error) ? false : query.state.error ? 30_000 : query.state.data && !isFinishedJob(query.state.data.job.status) ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry,
  });
}
