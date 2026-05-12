import { useId } from "react";

export function BrandLogo({
  size = 32,
  className = "",
  variant = "color",
}: {
  size?: number;
  className?: string;
  variant?: "color" | "mono-dark" | "mono-light" | "gray";
}) {
  const uid = useId().replace(/[:]/g, "");
  const bg = `bg-${uid}`;
  const play = `play-${uid}`;
  const bar1 = `bar1-${uid}`;
  const bar2 = `bar2-${uid}`;
  const bar3 = `bar3-${uid}`;

  if (variant === "gray") {
    return (
      <svg viewBox="0 0 100 100" width={size} height={size} className={className} xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" rx="22" fill="#CBD5E1" />
        <path d="M30 28 L30 72 L62 50 Z" fill="#94A3B8" />
        <rect x="60" y="60" width="8" height="14" rx="2" fill="#94A3B8" />
        <rect x="70" y="50" width="8" height="24" rx="2" fill="#94A3B8" />
        <rect x="80" y="38" width="8" height="36" rx="2" fill="#94A3B8" />
      </svg>
    );
  }

  if (variant === "mono-dark") {
    return (
      <svg viewBox="0 0 100 100" width={size} height={size} className={className} xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" rx="22" fill="#0F172A" />
        <path d="M30 28 L30 72 L62 50 Z" fill="#8B5CF6" />
        <rect x="60" y="60" width="8" height="14" rx="2" fill="#8B5CF6" />
        <rect x="70" y="50" width="8" height="24" rx="2" fill="#8B5CF6" />
        <rect x="80" y="38" width="8" height="36" rx="2" fill="#8B5CF6" />
      </svg>
    );
  }

  if (variant === "mono-light") {
    return (
      <svg viewBox="0 0 100 100" width={size} height={size} className={className} xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" rx="22" fill="#F8FAFC" />
        <path d="M30 28 L30 72 L62 50 Z" fill="#8B5CF6" />
        <rect x="60" y="60" width="8" height="14" rx="2" fill="#8B5CF6" />
        <rect x="70" y="50" width="8" height="24" rx="2" fill="#8B5CF6" />
        <rect x="80" y="38" width="8" height="36" rx="2" fill="#8B5CF6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={bg} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1E1B4B" />
          <stop offset="100%" stopColor="#0B0B1E" />
        </linearGradient>
        <linearGradient id={play} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#C4B5FD" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
        <linearGradient id={bar1} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#06B6D4" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
        <linearGradient id={bar2} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#0EA5E9" />
          <stop offset="100%" stopColor="#6366F1" />
        </linearGradient>
        <linearGradient id={bar3} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22" fill={`url(#${bg})`} />
      <path d="M30 28 L30 72 L62 50 Z" fill={`url(#${play})`} />
      <rect x="60" y="60" width="8" height="14" rx="2" fill={`url(#${bar1})`} />
      <rect x="70" y="50" width="8" height="24" rx="2" fill={`url(#${bar2})`} />
      <rect x="80" y="38" width="8" height="36" rx="2" fill={`url(#${bar3})`} />
    </svg>
  );
}

export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 bg-clip-text text-transparent font-bold tracking-tight ${className}`}>
      ClipIQ
    </span>
  );
}
