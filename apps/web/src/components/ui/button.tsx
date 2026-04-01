import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive";
type ButtonSize = "default" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  default:
    "bg-[color:var(--accent)] text-[color:var(--accent-foreground)] hover:bg-[color:var(--accent-strong)]",
  secondary:
    "border border-[color:var(--border)] bg-white text-[color:var(--foreground)] hover:bg-[#f7f7f4]",
  ghost: "text-[color:var(--muted-foreground)] hover:bg-black/4 hover:text-[color:var(--foreground)]",
  destructive: "bg-rose-50 text-rose-700 hover:bg-rose-100"
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-11 px-4 text-sm",
  sm: "h-8 px-3 text-xs"
};

export function Button({ className, variant = "default", size = "default", type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-2xl font-medium transition duration-200 disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  );
}
