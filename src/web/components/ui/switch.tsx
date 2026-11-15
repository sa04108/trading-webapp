import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Switch({
  className,
  children,
  trackContent,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  trackContent?: React.ReactNode;
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border-4 border-transparent outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-primary aria-[checked=false]:bg-input",
        className,
      )}
      {...props}
    >
      {trackContent}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none relative z-10 flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow-sm transition-transform motion-reduce:transition-none data-[state=checked]:translate-x-full data-[state=unchecked]:translate-x-0 [&_svg]:size-4"
      >
        {children}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
