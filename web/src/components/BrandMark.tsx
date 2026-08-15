import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Vector rainflow mark. currentColor so it matches the wordmark in light and dark. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="212 280 786 569"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <g transform="translate(0 1200) scale(0.1 -0.1)">
        <path d="M6809 8985 c-329 -52 -646 -195 -944 -429 -49 -38 -378 -356 -730 -706 -352 -350 -669 -659 -705 -687 -214 -165 -385 -249 -591 -288 -108 -20 -294 -19 -405 2 -187 36 -296 11 -390 -89 -117 -125 -129 -288 -29 -406 78 -92 395 -187 669 -199 413 -18 830 124 1221 417 60 45 167 144 270 250 360 371 915 926 1028 1028 464 418 941 624 1506 649 131 6 146 8 171 30 58 49 46 101 -42 175 -223 188 -466 269 -798 267 -80 -1 -184 -7 -231 -14z" />
        <path d="M8655 8641 c-128 -33 -225 -155 -225 -281 0 -102 69 -211 166 -260 67 -34 168 -34 236 -1 60 29 132 108 152 168 61 178 -61 365 -247 378 -29 2 -65 1 -82 -4z" />
        <path d="M7530 7749 c-370 -33 -741 -187 -1070 -442 -36 -28 -360 -344 -720 -702 -665 -661 -748 -736 -938 -854 -245 -153 -518 -251 -790 -286 -70 -9 -141 -18 -159 -21 -50 -7 -124 -63 -151 -114 -19 -36 -23 -56 -20 -101 6 -80 30 -108 149 -169 202 -104 334 -135 569 -134 131 1 186 6 270 23 210 45 419 127 604 236 212 125 267 174 941 850 570 572 655 654 775 742 246 182 452 293 705 377 172 58 410 105 531 107 118 1 201 61 211 153 3 24 3 56 -1 70 -16 65 -111 131 -271 189 -171 61 -441 94 -635 76z" />
        <path d="M9052 7639 c-103 -51 -151 -130 -151 -249 -1 -108 58 -202 154 -246 48 -23 60 -24 276 -24 l226 0 60 30 c204 102 204 393 1 494 -51 26 -55 26 -278 26 l-227 0 -61 -31z" />
        <path d="M8085 6511 c-354 -63 -677 -209 -946 -428 -37 -29 -324 -310 -638 -623 -314 -313 -633 -622 -708 -686 -152 -128 -351 -265 -491 -337 -239 -124 -590 -225 -792 -228 -68 -1 -111 -16 -149 -52 -36 -33 -47 -77 -29 -110 28 -52 169 -157 295 -221 323 -162 791 -134 1196 70 120 61 258 150 382 248 62 49 346 326 745 726 703 705 729 728 945 834 326 161 645 169 1024 24 84 -31 120 -40 172 -40 127 -1 247 81 307 210 22 47 27 71 27 137 0 97 -27 157 -100 224 -100 93 -424 212 -695 256 -133 21 -413 19 -545 -4z" />
        <path d="M2501 5489 c-61 -24 -127 -84 -156 -144 -28 -56 -28 -194 0 -250 25 -51 85 -108 143 -137 44 -22 60 -23 279 -26 147 -2 252 1 287 8 137 28 230 147 228 292 -2 105 -58 194 -157 246 l-50 27 -260 2 c-244 2 -263 1 -314 -18z" />
        <path d="M7773 4842 c-63 -22 -65 -24 -430 -385 -335 -331 -348 -350 -347 -472 0 -82 21 -130 81 -187 51 -49 99 -68 175 -68 110 0 123 11 489 375 184 184 340 348 352 370 29 54 31 183 3 235 -64 122 -198 177 -323 132z" />
        <path d="M3550 4511 c-121 -37 -200 -146 -200 -276 0 -115 51 -198 155 -253 68 -36 169 -37 236 -4 108 53 164 142 164 262 -1 90 -30 157 -96 213 -67 58 -177 82 -259 58z" />
      </g>
    </svg>
  );
}

export function BrandMark({
  name,
  tagline,
  iconUrl,
  leading,
  size = "nav",
  collapsed = false,
  nameClassName,
}: {
  name: string;
  tagline?: string | null;
  iconUrl?: string | null;
  leading?: ReactNode;
  size?: "nav" | "hero";
  collapsed?: boolean;
  nameClassName?: string;
}) {
  const hero = size === "hero";
  const label = tagline?.trim() || "";
  const glyphClass = collapsed
    ? "size-5 text-foreground"
    : hero
      ? "h-[0.86em] w-[1.22em] text-foreground"
      : "size-5 text-foreground";

  const icon = leading ?? (iconUrl ? (
    <img
      src={iconUrl}
      alt=""
      className={cn(
        "shrink-0 object-contain object-center dark:invert",
        collapsed ? "size-5" : hero ? "h-[0.86em] w-[1.22em]" : "size-5",
      )}
    />
  ) : (
    <BrandGlyph className={cn("shrink-0", glyphClass)} />
  ));

  if (collapsed) {
    return <span className="flex items-center justify-center">{icon}</span>;
  }

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center",
        hero ? "justify-center gap-2.5 text-[2.5rem] sm:text-[2.75rem]" : "gap-2 text-[17px]",
      )}
    >
      {icon}
      <span className="inline-flex min-w-0 items-end gap-1">
        <span
          className={cn(
            "min-w-0 truncate font-brand font-semibold leading-none tracking-[-0.04em] text-foreground",
            nameClassName,
          )}
        >
          {name}
        </span>
        {label ? (
          <span
            className={cn(
              "mb-px shrink-0 rounded-[3px] bg-foreground font-sans font-medium tracking-wide text-background",
              hero ? "px-1.5 py-0.5 text-[11px] leading-4" : "px-1 py-px text-[8px] leading-3",
            )}
          >
            {label}
          </span>
        ) : null}
      </span>
    </span>
  );
}
