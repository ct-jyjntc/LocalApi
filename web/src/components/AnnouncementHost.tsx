import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone, X } from "lucide-react";
import { api, type Announcement } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const DAY_DISMISS_PREFIX = "localapi_announcement_day:";

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayDismissKey(updatedAt: string) {
  return `${DAY_DISMISS_PREFIX}${updatedAt || "none"}`;
}

/** True if user chose "hide today" for this announcement version. */
function isHiddenToday(updatedAt: string) {
  try {
    return localStorage.getItem(dayDismissKey(updatedAt)) === todayKey();
  } catch {
    return false;
  }
}

function hideForToday(updatedAt: string) {
  try {
    localStorage.setItem(dayDismissKey(updatedAt), todayKey());
  } catch {
    // ignore
  }
}

function shouldShowPopup(announcement: Announcement) {
  if (!announcement.enabled || !announcement.popup || !announcement.content.trim()) return false;
  // Only "今日关闭" suppresses re-popup; plain close shows again on next open/reload.
  if (isHiddenToday(announcement.updated_at)) return false;
  return true;
}

export function AnnouncementHost() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const branding = useQuery({ queryKey: ["branding"], queryFn: api.branding, staleTime: 60_000 });
  const announcement = branding.data?.announcement;
  const [popupOpen, setPopupOpen] = useState(false);
  /** After plain "关闭", stay closed until full remount / reload. */
  const closedThisVisit = useRef(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [needsMarquee, setNeedsMarquee] = useState(false);

  const active = Boolean(announcement?.enabled && announcement.content.trim());
  const marqueeText = useMemo(() => {
    if (!active || !announcement) return "";
    const title = announcement.title?.trim();
    const content = announcement.content.trim().replace(/\s+/g, " ");
    return title ? `${title}：${content}` : content;
  }, [active, announcement]);

  useEffect(() => {
    if (!announcement) {
      setPopupOpen(false);
      return;
    }
    if (closedThisVisit.current) {
      setPopupOpen(false);
      return;
    }
    setPopupOpen(shouldShowPopup(announcement));
  }, [announcement?.enabled, announcement?.popup, announcement?.updated_at, announcement?.content]);

  // Measure real overflow: only scroll when text is wider than the bar.
  useLayoutEffect(() => {
    if (!active) {
      setNeedsMarquee(false);
      return;
    }
    const measure = () => {
      const track = trackRef.current;
      const text = textRef.current;
      if (!track || !text) {
        setNeedsMarquee(false);
        return;
      }
      // Compare natural text width vs visible track (text is not duplicated when measuring).
      setNeedsMarquee(text.scrollWidth > track.clientWidth + 1);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (trackRef.current) ro?.observe(trackRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, marqueeText]);

  if (!active || !announcement) return null;

  const showBanner = announcement.banner !== false;
  const showPopup = Boolean(announcement.popup);

  const closeOnce = () => {
    closedThisVisit.current = true;
    setPopupOpen(false);
  };
  const dismissToday = () => {
    hideForToday(announcement.updated_at);
    closedThisVisit.current = true;
    setPopupOpen(false);
  };

  // Nothing visible if both surfaces are off.
  if (!showBanner && !showPopup) return null;

  return (
    <>
      {showBanner ? (
        <div className="sticky top-0 z-[25] border-b border-amber-500/20 bg-amber-50/95 text-amber-950 backdrop-blur dark:border-amber-400/15 dark:bg-amber-950/40 dark:text-amber-50">
          <div className="flex h-9 items-center gap-2 px-3 sm:px-4">
            <Megaphone className="size-3.5 shrink-0 opacity-80" strokeWidth={1.8} />
            <div ref={trackRef} className="relative min-w-0 flex-1 overflow-hidden">
              {/* Hidden measurer: single copy, no animation */}
              <div
                ref={textRef}
                className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-[12px] leading-9"
                aria-hidden
              >
                {marqueeText}
              </div>
              <div
                className={cn(
                  "whitespace-nowrap text-[12px] leading-9",
                  needsMarquee ? "inline-block announcement-marquee-track" : "truncate",
                )}
                title={marqueeText}
              >
                {needsMarquee ? `${marqueeText}　　${marqueeText}` : marqueeText}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={showPopup && popupOpen}
        onOpenChange={(open) => {
          if (!open) closeOnce();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="size-4 text-muted-foreground" strokeWidth={1.8} />
              {announcement.title?.trim() || (zh ? "公告" : "Announcement")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {zh ? "站点公告" : "Site announcement"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
            {announcement.content}
          </div>
          <DialogFooter className="mt-2 gap-2 sm:justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={dismissToday}>
              {zh ? "今日关闭" : "Hide today"}
            </Button>
            <Button type="button" size="sm" onClick={closeOnce}>
              <X data-icon="inline-start" className="size-3.5" />
              {zh ? "关闭" : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <style>{`
        .announcement-marquee-track {
          animation: announcement-marquee 22s linear infinite;
        }
        @keyframes announcement-marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .announcement-marquee-track { animation: none; }
        }
      `}</style>
    </>
  );
}
