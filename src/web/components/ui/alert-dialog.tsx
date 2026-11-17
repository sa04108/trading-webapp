import * as React from "react";
import { AlertDialog as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

const AlertDialog = Primitive.Root;
const AlertDialogCancel = Primitive.Cancel;
const AlertDialogPortal = Primitive.Portal;
function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof Primitive.Overlay>) {
  return <Primitive.Overlay className={cn("fixed inset-0 z-50 bg-black/50", className)} {...props} />;
}
function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return <AlertDialogPortal><AlertDialogOverlay /><Primitive.Content className={cn("fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg", className)} {...props} /></AlertDialogPortal>;
}
function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}
function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle };
