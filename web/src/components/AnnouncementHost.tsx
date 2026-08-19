import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

function useBrandingAnnouncement() {
  const branding = useQuery({ queryKey: ["branding"], queryFn: api.branding, staleTime: 60_000 });
  return branding.data?.announcement;
}

/** Popup surface — mounted once in the app shell. */
export function AnnouncementHost() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const announcement = useBrandingAnnouncement();
  const [popupOpen, setPopupOpen] = useState(false);
  /** After plain "关闭", stay closed until full remount / reload. */
  const closedThisVisit = useRef(false);

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

  if (!announcement?.enabled || !announcement.popup || !announcement.content.trim()) return null;

  const bannerTitle = announcement.title?.trim() || "";
  const closeOnce = () => {
    closedThisVisit.current = true;
    setPopupOpen(false);
  };
  const dismissToday = () => {
    hideForToday(announcement.updated_at);
    closedThisVisit.current = true;
    setPopupOpen(false);
  };

  return (
    <Dialog
      open={popupOpen}
      onOpenChange={(open) => {
        if (!open) closeOnce();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bannerTitle || (zh ? "公告" : "Announcement")}</DialogTitle>
          <DialogDescription className="sr-only">
            {zh ? "站点公告" : "Site announcement"}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/55 px-3 py-2.5 text-xs leading-5">
          {announcement.content}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="text-muted-foreground"
            onClick={dismissToday}
          >
            {zh ? "今日关闭" : "Hide today"}
          </Button>
          <Button type="button" size="sm" onClick={closeOnce}>
            {zh ? "知道了" : "Got it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Banner surface — an in-content strip with marquee, rendered on the overview page. */
export function AnnouncementBanner() {
  const announcement = useBrandingAnnouncement();

  const trackRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [needsMarquee, setNeedsMarquee] = useState(false);

  const active = Boolean(announcement?.enabled && announcement.banner !== false && announcement.content.trim());
  const bannerTitle = announcement?.title?.trim() || "";
  const marqueeText = useMemo(() => {
    if (!active || !announcement) return "";
    return announcement.content.trim().replace(/\s+/g, " ");
  }, [active, announcement]);

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

  if (!active) return null;

  return (
    <div className="flex h-9 items-center gap-2.5 rounded-lg border border-border/60 bg-secondary/35 px-3">
      {bannerTitle ? (
        <>
          <span className="shrink-0 text-[11px] text-muted-foreground">{bannerTitle}</span>
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden />
        </>
      ) : null}
      <div ref={trackRef} className="relative min-w-0 flex-1 overflow-hidden">
        <div
          ref={textRef}
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-xs leading-9"
          aria-hidden
        >
          {marqueeText}
        </div>
        <div
          className={cn(
            "whitespace-nowrap text-xs leading-9 text-foreground/80",
            needsMarquee ? "inline-block announcement-marquee-track" : "truncate",
          )}
          title={marqueeText}
        >
          {needsMarquee ? `${marqueeText}　　${marqueeText}` : marqueeText}
        </div>
      </div>
    </div>
  );
}
