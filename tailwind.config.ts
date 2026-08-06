import type { Config } from "tailwindcss";

/**
 * The same near-square, hairline-separated vocabulary as `apps/navigator`.
 * Colour names map onto CSS custom properties rather than literals so the
 * light theme is a variable swap in `index.css` and nothing here changes.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces, darkest to lightest.
        surface: {
          0: "hsl(var(--bg-0))",
          1: "hsl(var(--bg-1))",
          2: "hsl(var(--bg-2))",
          3: "hsl(var(--bg-3))",
        },
        // Separation is hairlines, never shadows or fills.
        border: "hsl(var(--border-1))",
        hairline: {
          DEFAULT: "hsl(var(--border-1))",
          strong: "hsl(var(--border-2))",
        },
        ink: {
          1: "hsl(var(--text-1))",
          2: "hsl(var(--text-2))",
          3: "hsl(var(--text-3))",
          4: "hsl(var(--text-4))",
        },
        // One accent. Colour means state, never category.
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
        },
        warn: "hsl(var(--warn))",
        danger: "hsl(var(--danger))",
      },
      borderRadius: {
        // Near-square. The whole visual identity rests on this.
        lg: "var(--radius)",
        md: "var(--radius)",
        sm: "var(--radius)",
      },
      height: { head: "var(--head-height)" },
      minHeight: { head: "var(--head-height)" },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
export default config;
