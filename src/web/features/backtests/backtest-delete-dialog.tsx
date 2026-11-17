import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, postJson } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BacktestDeletionPreview } from "@shared/schemas/backtest-deletion";
import type { ExperimentMode } from "./experiment-paths";

/** 확인할 때마다 서버에서 삭제 범위를 다시 계산한다. */
export function BacktestDeleteDialog({ mode, ids, onClose, onDeleted }: {
  mode: ExperimentMode; ids: string[]; onClose: () => void; onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [changed, setChanged] = useState(false);
  const preview = useQuery({
    queryKey: ["backtest-deletion-preview", mode, ids],
    queryFn: () => postJson<BacktestDeletionPreview>("/backtests/deletion-preview", { mode, ids }),
    refetchOnMount: "always",
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (token: string) => postJson<void>("/backtests/delete", { mode, ids, token }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["backtests"] });
      void client.invalidateQueries({ queryKey: ["backtest-experiments"] });
      void client.invalidateQueries({ queryKey: ["intraday-runs"] });
      void client.invalidateQueries({ queryKey: ["intraday-run"] });
      void client.invalidateQueries({ queryKey: ["intraday-experiments"] });
      void client.invalidateQueries({ queryKey: ["backtest-clone-batches"] });
      void client.invalidateQueries({ queryKey: ["configuration-searches"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
      onDeleted();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setChanged(true);
        void preview.refetch();
      }
    },
  });
  const data = preview.data;
  return <Dialog open onOpenChange={(open) => { if (!open && !remove.isPending) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>백테스트 삭제</DialogTitle>
      <DialogDescription>백테스트와 연결된 실험 및 하위 결과가 함께 삭제됩니다. 되돌릴 수 없습니다.</DialogDescription>
    </DialogHeader>
    {preview.isFetching ? <p>삭제 범위를 확인하는 중입니다.</p> : preview.isError ? <div role="alert">삭제 범위를 불러오지 못했습니다. <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>다시 시도</Button></div> : data ? <div className="space-y-1 text-sm">
      <p>백테스트 결과 {data.backtestCount}개</p>
      {data.configurationSearchCount > 0 ? <p>설정 탐색 실험 {data.configurationSearchCount}개</p> : null}
      {data.periodValidationCount > 0 ? <p>기간검증 {data.periodValidationCount}개</p> : null}
      {data.configurationSearchCount > 0 || data.periodValidationCount > 0 ? <p>실험에 속한 결과를 삭제하면 해당 실험의 다른 결과도 함께 삭제됩니다.</p> : null}
      {data.blockers.map((blocker) => <p role="alert" key={blocker}>{blocker}</p>)}
    </div> : null}
    {changed ? <p role="alert">삭제 범위가 변경되었습니다. 내용을 다시 확인해 주세요.</p> : null}
    {remove.isError && !(remove.error instanceof ApiError && remove.error.status === 409) ? <p role="alert">{remove.error.message}</p> : null}
    <DialogFooter><Button variant="outline" disabled={remove.isPending} onClick={onClose}>취소</Button><Button variant="destructive" disabled={!data || preview.isFetching || preview.isError || data.blockers.length > 0 || remove.isPending} onClick={() => { setChanged(false); if (data) remove.mutate(data.token); }}>삭제</Button></DialogFooter></DialogContent>
  </Dialog>;
}
