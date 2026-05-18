export function BrandLogo({
  size = 32,
  className = "",
  variant = "color",
}: {
  size?: number;
  className?: string;
  variant?: "color" | "mono-dark" | "mono-light" | "gray";
}) {
  const palette = (() => {
    switch (variant) {
      case "mono-dark":
        // dark canvas, light marks
        return { bg: "#0F172A", frameBack: "#312e81", frameMid: "#6366f1", frameTop: "#F8FAFC", play: "#0F172A" };
      case "mono-light":
        // light canvas, dark marks
        return { bg: "#F8FAFC", frameBack: "#c7cbf5", frameMid: "#6366f1", frameTop: "#1c1e2a", play: "#F8FAFC" };
      case "gray":
        return { bg: "#94a3b8", frameBack: "#475569", frameMid: "#cbd5e1", frameTop: "#f8fafc", play: "#94a3b8" };
      case "color":
      default:
        // brand indigo canvas, white top frame, indigo play knockout
        return { bg: "#4f46e5", frameBack: "#3730a3", frameMid: "#a5a4f2", frameTop: "#ffffff", play: "#4f46e5" };
    }
  })();

  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="22" fill={palette.bg} />
      <rect x="18" y="22" width="46" height="34" rx="9" fill={palette.frameBack} />
      <rect x="28" y="32" width="46" height="34" rx="9" fill={palette.frameMid} />
      <rect x="38" y="42" width="46" height="34" rx="9" fill={palette.frameTop} />
      <path
        d="M57 51 Q55 51 55 54 L55 64 Q55 67 57 67 Q58 67 59 66 L71 60 Q73 59 73 59 Q73 59 71 58 L59 52 Q58 51 57 51 Z"
        fill={palette.play}
      />
    </svg>
  );
}

