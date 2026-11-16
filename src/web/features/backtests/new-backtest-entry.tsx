import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { postJson } from "@/lib/api-client";

export function NewBacktestEntry() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sourceJobId = new URLSearchParams(search).get("from") || null;
  const started = useRef(false);
  const create = useMutation({
    mutationFn: () => postJson<{ wizard: { id: string } }>("/backtests/wizards", sourceJobId === null ? {} : { sourceJobId }),
    onSuccess: ({ wizard }) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      const query = new URLSearchParams({ wizard: wizard.id });
      void navigate({ pathname: `/backtests/new/${sourceJobId === null ? "strategy" : "review"}`, search: `?${query}` }, { replace: true });
    },
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    create.mutate();
  }, [create]);
  if (create.isError) return <Alert variant="destructive" role="alert"><AlertDescription>위저드를 시작하지 못했습니다. <Button variant="outline" onClick={() => create.mutate()}>다시 시도</Button></AlertDescription></Alert>;
  return <Skeleton className="mx-auto h-64 w-full max-w-2xl" />;
}
