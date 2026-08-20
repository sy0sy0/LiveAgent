import { ResourceActivationSwitch } from "@liveagent/ui/components/resources/ResourceActivationSwitch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentType, ReactNode } from "react";

export function ResourceSelectionCard(props: {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  checked: boolean;
  disabled?: boolean;
  warning?: boolean;
  metadata?: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}) {
  const Icon = props.icon;
  return (
    <article
      className={cn(
        "flex min-h-20 items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs transition-[border-color,background-color]",
        props.checked ? "border-emerald-600/25" : "border-border",
        props.disabled && "bg-muted/10",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{props.title}</span>
          {props.metadata}
        </div>
        <p
          className={cn(
            "mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground",
            props.warning && "text-amber-600 dark:text-amber-300",
          )}
          title={props.description}
        >
          {props.description}
        </p>
      </div>
      <ResourceActivationSwitch
        checked={props.checked}
        disabled={props.disabled}
        compact
        label={props.title}
        onCheckedChange={props.onCheckedChange}
      />
    </article>
  );
}
