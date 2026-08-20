const FROST_SPINNER_SEGMENTS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
] as const;

export function ScanActivityDots() {
  return (
    <span className="ml-0.5 inline-flex gap-[2px]" aria-hidden="true">
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
    </span>
  );
}

export function FrostSpinner() {
  return (
    <span className="hub-frost-spinner shrink-0" aria-hidden="true">
      {FROST_SPINNER_SEGMENTS.map((segment) => (
        <i key={segment} />
      ))}
    </span>
  );
}

export function SkillsContentLoadingState(props: { title: string; description: string }) {
  const { title, description } = props;
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite" aria-busy="true">
      <div className="hub-frost-hero hub-panel-enter px-4 py-3.5">
        <div className="flex items-center gap-3.5">
          <FrostSpinner />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium tracking-tight text-foreground">{title}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
              {description}
            </div>
          </div>
        </div>
        <div className="hub-frost-track mt-3.5" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {[1, 2, 3, 4, 5, 6].map((item) => (
          <div key={item} className="hub-frost-skeleton skill-card-enter p-3.5">
            <div className="flex items-center gap-3">
              <div className="skills-skeleton-shimmer h-9 w-9 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="skills-skeleton-shimmer h-3.5 w-28 rounded" />
                <div className="skills-skeleton-shimmer h-3 w-full max-w-[12rem] rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
