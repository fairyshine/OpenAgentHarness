import type { LabelHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]", className)} {...props} />;
}
