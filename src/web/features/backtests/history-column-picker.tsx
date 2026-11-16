import { useId, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Columns3, GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  HISTORY_TABLE_COLUMNS,
  type HistoryColumnId,
  useHistoryTablePreferences,
} from "./history-table-preferences";

function ColumnOption({ id, checked, onCheckedChange }: {
  id: HistoryColumnId;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const checkboxId = useId();
  const column = HISTORY_TABLE_COLUMNS.find((item) => item.id === id)!;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative flex items-center rounded-md bg-popover", isDragging && "z-10 bg-muted shadow-md")}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon"
        className="size-11 touch-none cursor-grab text-muted-foreground active:cursor-grabbing sm:size-8"
        {...attributes}
        {...listeners}
        aria-label={`${column.label} 순서 변경`}
      >
        <GripVertical aria-hidden />
      </Button>
      <Checkbox id={checkboxId} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} aria-label={`${column.label} 표시`} />
      <Label htmlFor={checkboxId} className="min-h-11 flex-1 cursor-pointer pl-2 text-xs font-normal sm:min-h-9">
        {column.label}
      </Label>
    </li>
  );
}

export function HistoryColumnPicker({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const preferences = useHistoryTablePreferences();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const describe = (id: string | number) => HISTORY_TABLE_COLUMNS.find((item) => item.id === id)?.label ?? "항목";
  return (
    <Popover open={enabled && open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {enabled ? (
            <PopoverTrigger asChild>
              <Button variant="outline" className="size-11 p-0 sm:h-8 sm:w-auto sm:gap-1.5 sm:px-2.5" aria-label="표시 항목">
                <Columns3 aria-hidden /><span className="hidden sm:inline">표시 항목</span>
              </Button>
            </PopoverTrigger>
          ) : null}
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="end" side="bottom" sideOffset={8} avoidCollisions={false}
        className="w-52 p-3"
        aria-labelledby={titleId}
        onEscapeKeyDown={(event) => { if (dragging) event.preventDefault(); }}
      >
        <div className="mb-1 flex items-center justify-between">
          <h4 id={titleId} className="text-sm font-medium">표시 항목</h4>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="표시 항목 닫기"><X aria-hidden /></Button>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          autoScroll={false}
          accessibility={{
            screenReaderInstructions: { draggable: "스페이스 키로 항목을 잡고 위아래 방향키로 이동한 뒤 다시 스페이스 키로 놓습니다. Esc 키로 취소합니다." },
            announcements: {
              onDragStart: ({ active }) => `${describe(active.id)} 순서를 변경합니다.`,
              onDragOver: ({ active, over }) => over ? `${describe(active.id)}, ${preferences.order.indexOf(over.id as HistoryColumnId) + 1}번째 위치입니다.` : undefined,
              onDragEnd: ({ active, over }) => over ? `${describe(active.id)}, ${preferences.order.indexOf(over.id as HistoryColumnId) + 1}번째 위치로 이동했습니다.` : "순서 변경을 취소했습니다.",
              onDragCancel: () => "순서 변경을 취소했습니다.",
            },
          }}
          onDragStart={() => setDragging(true)}
          onDragCancel={() => setDragging(false)}
          onDragEnd={({ active, over }) => {
            setDragging(false);
            if (!over || active.id === over.id) return;
            const from = preferences.order.indexOf(active.id as HistoryColumnId);
            const to = preferences.order.indexOf(over.id as HistoryColumnId);
            if (from !== -1 && to !== -1) preferences.setOrder(arrayMove(preferences.order, from, to));
          }}
        >
          <SortableContext items={preferences.order} strategy={verticalListSortingStrategy}>
            <ul aria-label="표시 항목 순서">
              {preferences.order.map((id) => <ColumnOption key={id} id={id} checked={preferences.visible.includes(id)} onCheckedChange={(checked) => preferences.setVisible(id, checked)} />)}
            </ul>
          </SortableContext>
        </DndContext>
      </PopoverContent>
    </Popover>
  );
}
