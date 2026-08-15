import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type PriceWindowForm = {
  start: string;
  end: string;
  days: number[];
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const DAY_EN = ["S", "M", "T", "W", "T", "F", "S"];

export function emptyPriceWindow(base?: Pick<PriceWindowForm, "input" | "output" | "cacheRead" | "cacheWrite">): PriceWindowForm {
  return {
    start: "08:00",
    end: "22:00",
    days: [],
    input: base?.input ?? "0",
    output: base?.output ?? "0",
    cacheRead: base?.cacheRead ?? "0",
    cacheWrite: base?.cacheWrite ?? "0",
  };
}

export function PriceWindowsEditor({
  windows,
  onChange,
  zh,
  base,
}: {
  windows: PriceWindowForm[];
  onChange: (windows: PriceWindowForm[]) => void;
  zh: boolean;
  base: Pick<PriceWindowForm, "input" | "output" | "cacheRead" | "cacheWrite">;
}) {
  const update = (index: number, patch: Partial<PriceWindowForm>) => {
    onChange(windows.map((window, i) => (i === index ? { ...window, ...patch } : window)));
  };

  const toggleDay = (index: number, day: number) => {
    const current = windows[index].days.length === 0 ? ALL_DAYS : windows[index].days;
    const next = current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b);
    update(index, { days: next.length === 0 || next.length === 7 ? [] : next });
  };

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>{zh ? "分时段定价" : "Time-of-day prices"}</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {zh
              ? "未命中任何时段时使用上方默认价。时区 Asia/Shanghai；支持跨午夜（如 22:00–08:00）；靠前的时段优先。"
              : "Default rates apply when no window matches. Timezone Asia/Shanghai; overnight ranges such as 22:00–08:00 are allowed. Earlier windows win."}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 text-muted-foreground"
          disabled={windows.length >= 16}
          onClick={() => onChange([...windows, emptyPriceWindow(base)])}
        >
          <Plus className="size-3.5" />
          {zh ? "添加时段" : "Add window"}
        </Button>
      </div>
      {windows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{zh ? "尚未配置时段，全天使用默认价。" : "No windows. Default rates apply all day."}</p>
      ) : (
        <div className="space-y-2">
          {windows.map((window, index) => {
            const selected = window.days.length === 0 ? ALL_DAYS : window.days;
            return (
              <div key={index} className="space-y-2.5 rounded-md bg-secondary/55 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="time" className="w-[7.5rem]" value={window.start} onChange={(e) => update(index, { start: e.target.value })} />
                  <span className="text-[11px] text-muted-foreground">–</span>
                  <Input type="time" className="w-[7.5rem]" value={window.end} onChange={(e) => update(index, { end: e.target.value })} />
                  <div className="flex flex-wrap gap-1">
                    {ALL_DAYS.map((day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(index, day)}
                        className={cn(
                          "flex size-7 items-center justify-center rounded-full text-[11px] transition-colors",
                          selected.includes(day)
                            ? "bg-foreground text-background"
                            : "bg-background/70 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {zh ? DAY_ZH[day] : DAY_EN[day]}
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(windows.filter((_, i) => i !== index))}
                    aria-label={zh ? "删除时段" : "Remove window"}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniField label={zh ? "输入" : "Input"} value={window.input} onChange={(input) => update(index, { input })} />
                  <MiniField label={zh ? "输出" : "Output"} value={window.output} onChange={(output) => update(index, { output })} />
                  <MiniField label={zh ? "缓存读" : "Cache read"} value={window.cacheRead} onChange={(cacheRead) => update(index, { cacheRead })} />
                  <MiniField label={zh ? "缓存写" : "Cache write"} value={window.cacheWrite} onChange={(cacheWrite) => update(index, { cacheWrite })} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="min-w-0 space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input type="number" step="0.000001" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
